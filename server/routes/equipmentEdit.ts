import type { Express, Request, Response } from 'express';
import { getPrisma, sendError } from '../context.js';
import { ROLES, roleById, roleFits, type RoleId } from '../../equipment/roles.js';
import { isClassId } from '../../equipment/classes.js';
import { autoFixTag, validateTag } from '../../equipment/tagPolicy.js';
import { importPolicyOfProject } from './tagPolicy.js';
import { planTagParents, parentSetByHand, type TaggedPosition } from '../equipmentHierarchy.js';

/**
 * Правка реестра оборудования вручную: удаление лишней позиции.
 *
 * Импорт бланка иногда заводит то, чего в проекте нет: строку примечания
 * приняли за изделие, лишний раз загрузили тот же файл, или человек просто
 * ошибся. До сих пор убрать можно было только узел целиком — вместе со всем
 * его оборудованием, — и ради одной лишней строки люди сносили установку и
 * импортировали её заново.
 *
 * Сюда же легли ручные позиции. Расчёт знает не всё: датчик ПТС, поставленный
 * на электродвигатель уже на объекте, в выгрузке САПР не появится никогда, а
 * тег и параметры у него есть, и в таблицу он попадать обязан. Ручная позиция
 * живёт по тем же правилам, что и позиция из файла, с одним отличием: файл её
 * не знает и потому не может удалить при повторном импорте.
 *
 * Отдельным модулем, а не в server.ts: тот у предела размера, а правка реестра
 * будет обрастать (переименование, перенос между узлами) и должна жить там,
 * где её видно.
 */

const authUserOf = (req: Request) => (req as any).authUser || null;

export function registerEquipmentEditRoutes(app: Express): void {
  /**
   * Удалить позицию оборудования.
   *
   * Теги НЕ удаляются вместе с ней. Тег — адрес позиции в проекте, он живёт в
   * своём реестре и может быть переиспользован; удалить его вместе с изделием
   * значило бы потерять адрес, на который ссылаются документы и переписка.
   * Связь просто снимается, и тег остаётся свободным.
   *
   * Предупреждение о связях считается ДО удаления и возвращается вызывающему:
   * узнать, что позиция была привязана к трём документам, после того как её не
   * стало, — бесполезно.
   */
  app.delete('/api/equipment/component/:id', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const me = authUserOf(req);
      const found = await prisma.componentElement.findUnique({
        where: { id: req.params.id },
        include: {
          tags: { select: { id: true, identifier: true } },
          monoblock: { select: { id: true, name: true, systemId: true } },
        },
      });
      if (!found) return res.json({ ok: true, alreadyGone: true });

      const tags = (found.tags || []).map((t: any) => t.identifier);

      /**
       * Что стояло внутри — не исчезает вместе с владельцем.
       *
       * Датчик, заведённый инженером на двигателе, к удаляемому двигателю
       * отношения не имеет: его ставили руками и ради него держат тег. Дети
       * поднимаются на уровень выше, и об этом сказано в ответе — молча
       * растворяться позиция не должна.
       */
      const children = await prisma.componentElement.findMany({
        where: { parentElementId: found.id },
        select: { id: true, name: true },
      });

      await prisma.$transaction(async (tx: any) => {
        // Сначала снимаем теги: иначе удаление позиции унесло бы связь молча,
        // и тег остался бы числиться занятым
        if (found.tags?.length) {
          await tx.componentElement.update({
            where: { id: found.id },
            data: { tags: { disconnect: found.tags.map((t: any) => ({ id: t.id })) } },
          });
        }
        if (children.length) {
          await tx.componentElement.updateMany({
            where: { parentElementId: found.id },
            data: { parentElementId: found.parentElementId ?? null },
          });
        }
        await tx.componentElement.delete({ where: { id: found.id } });
      });

      // Удаление реестра — событие, которое должно быть видно: кто и что убрал
      try {
        await prisma.systemChangeLog.create({
          data: {
            userName: me?.name || 'Неизвестно',
            userSymbol: me?.symbol || '',
            description: `Удалена позиция «${found.name || found.itemCode}»`
              + (found.monoblock?.name ? ` из «${found.monoblock.name}»` : '')
              + (tags.length ? `; освобождены теги: ${tags.join(', ')}` : ''),
            targetRoute: found.monoblock?.systemId ? `/equipment?system=${found.monoblock.systemId}` : '/equipment',
          },
        });
      } catch (_) { /* журнал не обязан существовать, удаление уже состоялось */ }

      res.json({
        ok: true, name: found.name, itemCode: found.itemCode, freedTags: tags,
        ...(children.length ? { moved: children.map((c: any) => c.name) } : {}),
      });
    } catch (err: any) { sendError(res, err); }
  });

  /**
   * Что потянет за собой удаление — спрашивается до него.
   *
   * Отдельным запросом, потому что предупреждение показывается в диалоге
   * подтверждения: «у позиции два тега и она в трёх документах» меняет решение
   * человека, а после удаления эта же строка бесполезна.
   */
  app.get('/api/equipment/component/:id/links', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const found = await prisma.componentElement.findUnique({
        where: { id: req.params.id },
        include: { tags: { select: { identifier: true } } },
      });
      if (!found) return res.status(404).json({ error: 'Позиция не найдена' });
      const children = await prisma.componentElement.findMany({
        where: { parentElementId: found.id },
        select: { id: true, name: true, itemCode: true, role: true, manual: true },
      });
      res.json({
        name: found.name,
        itemCode: found.itemCode,
        tags: (found.tags || []).map((t: any) => t.identifier),
        /**
         * Что стоит внутри позиции.
         *
         * Удаление вентилятора уносит с собой двигатель, а ручной датчик на
         * этом двигателе человек заводил сам — узнать об этом он должен ДО
         * удаления, а не после.
         */
        children,
        manualChildren: children.filter((c: any) => c.manual).length,
      });
    } catch (err: any) { sendError(res, err); }
  });

  /** Список ролей для выпадающего списка «Добавить позицию». */
  app.get('/api/equipment/roles', async (_req: Request, res: Response) => {
    res.json({ roles: ROLES.map(r => ({ id: r.id, title: r.title, children: r.children || [] })) });
  });

  /**
   * Поправить тип и вид позиции.
   *
   * Тип угадывается правилами (`equipment/classes.ts`), и угадывание бывает
   * неверным: блок-корпус, который на объекте всё-таки считают вентилятором,
   * или вид, которого правила не знают. Поправка пишется в две колонки и
   * сильнее правил; пустое значение возвращает угадывание.
   */
  app.put('/api/equipment/component/:id/class', async (req: Request, res: Response) => {
    try {
      const equipClass = String(req.body?.equipClass ?? '').trim();
      const equipKind = String(req.body?.equipKind ?? '').trim().slice(0, 120);
      if (equipClass && !isClassId(equipClass)) {
        return res.status(400).json({ error: `Типа «${equipClass}» нет в справочнике типов` });
      }
      const row = await getPrisma().componentElement.update({
        where: { id: req.params.id },
        data: { equipClass: equipClass || null, equipKind: equipKind || null },
      });
      res.json({ ok: true, equipClass: row.equipClass || '', equipKind: row.equipKind || '' });
    } catch (err: any) { sendError(res, err); }
  });

  /**
   * Завести позицию внутри существующей — вручную.
   *
   * Пример владельца проекта: «для электродвигателя можно самому добавить
   * позицию, датчик ПТС, и присвоить тег его, а потом ещё какие-то параметры».
   *
   * Роль не навязывается: `roleFits` знает обычный состав, но объект бывает
   * устроен не по учебнику, и запрещать инженеру описывать то, что он видит
   * своими глазами, программа не вправе. Несовпадение возвращается словами
   * подсказкой, а не отказом.
   */
  app.post('/api/equipment/component/:id/position', async (req: Request, res: Response) => {
    try {
      const parent = await getPrisma().componentElement.findUnique({
        where: { id: req.params.id },
        include: { monoblock: { select: { id: true, name: true, systemId: true, system: { select: { projectId: true } } } } },
      });
      if (!parent) return res.status(404).json({ error: 'Позиция, внутрь которой добавляют, не найдена' });
      await createPosition(req, res, { monoblockId: parent.monoblockId, parent, projectId: parent.monoblock?.system?.projectId || '' });
    } catch (err: any) { sendError(res, err); }
  });

  /**
   * Завести позицию в моноблоке, без владельца.
   *
   * Не всё стоит внутри чего-то: отдельный шкаф управления или клеммная
   * коробка на корпусе моноблока — позиции верхнего уровня.
   */
  app.post('/api/equipment/monoblock/:id/position', async (req: Request, res: Response) => {
    try {
      const mono = await getPrisma().monoblock.findUnique({
        where: { id: req.params.id }, include: { system: { select: { projectId: true } } },
      });
      if (!mono) return res.status(404).json({ error: 'Моноблок не найден' });
      await createPosition(req, res, { monoblockId: mono.id, parent: null, projectId: mono.system?.projectId || '', base: mono.name });
    } catch (err: any) { sendError(res, err); }
  });

  /**
   * Проверить тег до записи — ничего не пишет.
   *
   * Окно показывает ответ, пока человек набирает: «будет записан как
   * 3700-B01-CC-001A», «занят: клапан 1.1», «свободен, привяжется». Правило
   * одно — то же, по которому тег потом и запишется (`resolveTag`), поэтому
   * обещание окна не расходится с результатом.
   */
  app.post('/api/projects/:id/tag-check', async (req: Request, res: Response) => {
    try {
      res.json(await resolveTag(getPrisma(), String(req.params.id || ''), req.body?.identifier, { dryRun: true }));
    } catch (err: any) { sendError(res, err); }
  });

  /**
   * Привязать к позиции тег по написанию: найти свободный или завести новый.
   *
   * «Создать и привязать» из окна выбора тега. Родитель тега встаёт сам — по
   * тому же правилу состава, что при импорте.
   */
  app.post('/api/equipment/component/:id/tag', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const comp = await prisma.componentElement.findUnique({
        where: { id: req.params.id }, include: { monoblock: { select: { system: { select: { projectId: true } } } } },
      });
      if (!comp) return res.status(404).json({ error: 'Позиция не найдена' });
      const projectId = comp.monoblock?.system?.projectId || '';
      const tag = await resolveTag(prisma, projectId, req.body?.identifier);
      if (!tag.ok) return res.status(tag.status || 400).json({ error: tag.problem, fix: tag.fix, field: 'tag' });
      await prisma.componentElement.update({ where: { id: comp.id }, data: { tags: { connect: { id: tag.tagId } } } });
      const parentTag = await linkParentTag(prisma, projectId, comp.id, tag.tagId!);
      res.json({ ok: true, identifier: tag.identifier, created: tag.created, corrected: tag.corrected, parentTag });
    } catch (err: any) { sendError(res, err); }
  });
}

export interface TagResolution {
  ok: boolean;
  status?: number;
  identifier: string;
  problem?: string;
  fix?: string;
  /** Исправленные двойники: «было СС → стало CC» */
  corrected?: { from: string; what: string };
  tagId?: string;
  /** Такой тег уже есть и свободен — привяжется он, а не новый */
  existing?: boolean;
  created?: boolean;
}

/**
 * Тег по написанию: исправить двойники, проверить правило проекта, найти
 * свободный или завести новый.
 *
 * Правило — то же, что у ввоза расчёта (`importPolicyOfProject`): код проекта
 * служит приставкой, пока не заданы другие, и тег с кириллическими «СС»
 * исправляется так же, как при импорте. Один тег — одно изделие: занятый тег
 * отказом, с названием того, кто его держит.
 */
export async function resolveTag(prisma: any, projectId: string, raw: unknown, opts: { dryRun?: boolean } = {}): Promise<TagResolution> {
  const written = String(raw ?? '').trim();
  const policy = await importPolicyOfProject(projectId);
  const fix = autoFixTag(written, policy);
  const check = validateTag(fix ? fix.identifier : written, policy);
  const corrected = fix ? { from: fix.from, what: fix.what } : undefined;
  if (!check.ok) return { ok: false, status: 400, identifier: check.identifier, problem: check.problem, fix: check.fix, corrected };
  const existing = await prisma.tag.findFirst({
    where: { projectId, identifier: check.identifier },
    include: { componentElements: { select: { id: true, name: true } } },
  });
  const busy = (existing?.componentElements || [])[0];
  if (busy) {
    return {
      ok: false, status: 409, identifier: check.identifier, corrected, existing: true,
      problem: `Тег «${check.identifier}» уже привязан к «${busy.name}». Один тег — одно изделие.`,
    };
  }
  if (existing) return { ok: true, identifier: check.identifier, corrected, tagId: existing.id, existing: true };
  if (opts.dryRun) return { ok: true, identifier: check.identifier, corrected, created: true };
  const made = await prisma.tag.create({ data: { identifier: check.identifier, projectId } });
  return { ok: true, identifier: check.identifier, corrected, tagId: made.id, created: true };
}

/** Общая часть обоих входов «завести позицию»: внутрь позиции и в моноблок */
async function createPosition(
  req: Request, res: Response,
  at: { monoblockId: string; parent: any | null; projectId: string; base?: string },
): Promise<void> {
  const prisma = getPrisma();
  const me = authUserOf(req);
  const name = String(req.body?.name || '').trim();
  if (!name) { res.status(400).json({ error: 'У позиции должно быть название' }); return; }
  const role = String(req.body?.role || 'ПРОЧЕЕ').trim() as RoleId;
  if (!ROLES.some(r => r.id === role)) { res.status(400).json({ error: `Роли «${role}» нет в списке ролей` }); return; }
  const equipClass = String(req.body?.equipClass || '').trim();
  const equipKind = String(req.body?.equipKind || '').trim().slice(0, 120);
  if (equipClass && !isClassId(equipClass)) { res.status(400).json({ error: `Типа «${equipClass}» нет в справочнике типов` }); return; }

  let tag: TagResolution | null = null;
  if (String(req.body?.tag || '').trim()) {
    tag = await resolveTag(prisma, at.projectId, req.body.tag);
    if (!tag.ok) { res.status(tag.status || 400).json({ error: tag.problem, fix: tag.fix, field: 'tag' }); return; }
  }

  // Код позиции строится от кода владельца (или моноблока) и роли, а номер
  // берётся первый свободный: два датчика на одном двигателе — обычное дело
  const siblings = await prisma.componentElement.findMany({
    where: { monoblockId: at.monoblockId },
    select: { itemCode: true, sourceOrder: true },
  });
  const taken = new Set(siblings.map((s: any) => s.itemCode));
  const base = `${at.parent ? at.parent.itemCode : (at.base || 'позиция')}/${role.toLowerCase()}`;
  let no = 1;
  while (taken.has(`${base}${no}`)) no++;
  const order = Math.max(0, ...siblings.map((s: any) => Number(s.sourceOrder) || 0)) + 1;

  const params = Array.isArray(req.body?.params) ? req.body.params : [];
  const groups = params.length
    ? [{
      title: 'Заведено вручную',
      params: params.slice(0, 200).map((p: any) => ({
        key: String(p?.key || '').trim() || 'Параметр',
        value: String(p?.value ?? ''),
        unit: String(p?.unit || ''),
      })).filter((p: any) => p.key),
    }]
    : [];

  const created = await prisma.componentElement.create({
    data: {
      monoblockId: at.monoblockId,
      itemCode: `${base}${no}`,
      name,
      equipType: role,
      specs: JSON.stringify({ groups }),
      version: 1,
      status: 'OK',
      role,
      parentElementId: at.parent ? at.parent.id : null,
      sourceOrder: order,
      manual: true,
      createdById: me?.id || null,
      equipClass: equipClass || null,
      equipKind: equipKind || null,
      ...(tag?.tagId ? { tags: { connect: { id: tag.tagId } } } : {}),
    },
  });

  // Родство тега: по тому же правилу, что и при импорте — тег ближайшего
  // тегированного владельца, а если такого нет, тег установки
  let parentTag = '';
  if (tag?.tagId) parentTag = await linkParentTag(prisma, at.projectId, created.id, tag.tagId);

  const parentRole = at.parent ? (at.parent.role || 'БЛОК') : 'БЛОК';
  const fits = roleFits(parentRole, role);
  res.json({
    ok: true,
    component: { id: created.id, itemCode: created.itemCode, name: created.name, role: created.role },
    parentTag,
    tag: tag ? { identifier: tag.identifier, created: !!tag.created, corrected: tag.corrected } : null,
    ...(fits ? {} : {
      warning: `Обычно «${roleById(role).title.toLowerCase()}» внутри «${roleById(parentRole).title.toLowerCase()}» не ставят.`
        + ' Позиция заведена — проверьте, что это именно то, что нужно.',
    }),
  });
}

/**
 * Поставить тегу новой позиции родителя по составу оборудования.
 *
 * Возвращает написание родительского тега — его показывают человеку сразу:
 * «датчик встал под тег двигателя», а не молча.
 */
async function linkParentTag(prisma: any, projectId: string, componentId: string, tagId: string): Promise<string> {
  if (!projectId) return '';
  const rows = await prisma.componentElement.findMany({
    where: { monoblock: { system: { projectId } } },
    select: { id: true, name: true, parentElementId: true, tags: { select: { id: true } }, monoblock: { select: { systemId: true } } },
  });
  const mine = rows.find((r: any) => r.id === componentId);
  if (!mine) return '';
  const sameSystem = rows.filter((r: any) => r.monoblock?.systemId === mine.monoblock?.systemId);

  const positions: TaggedPosition[] = sameSystem.map((r: any) => ({
    key: r.id,
    parentKey: r.parentElementId || '',
    title: r.name,
    tagId: (r.tags || [])[0]?.id,
  }));

  /**
   * Тег установки — тег позиции без владельца, у которой он есть.
   *
   * Его может не быть: обозначение установки иногда не проходит правило
   * проекта. Это не повод не строить родство вовсе — датчик внутри
   * тегированного двигателя должен встать под него и без корня. Пустой корень
   * означает только, что позициям без тегированного владельца родителя не
   * достанется, и выдумывать его никто не станет.
   */
  const root = positions.find(p => !p.parentKey && p.tagId);

  const tags = await prisma.tag.findMany({
    where: { projectId },
    select: { id: true, identifier: true, metadata: true },
  });
  const nodes = tags.map((t: any) => {
    const meta = safeMeta(t.metadata);
    return { id: t.id, connections: Array.isArray(meta.connections) ? meta.connections : [], parentId: meta.parentId ?? null };
  });
  const handSet = new Set<string>(tags.filter((t: any) => parentSetByHand(t.metadata)).map((t: any) => t.id));
  const plan = planTagParents(positions, root?.tagId || '', nodes, handSet);

  const metaById = new Map<string, any>(tags.map((t: any) => [t.id, safeMeta(t.metadata)]));
  for (const patch of plan.patches) {
    const meta = { ...(metaById.get(patch.id) || {}) };
    meta.connections = patch.connections;
    if (patch.parentId) meta.parentId = patch.parentId; else delete meta.parentId;
    if (meta.parentBy !== 'hand') meta.parentBy = 'import';
    await prisma.tag.update({ where: { id: patch.id }, data: { metadata: JSON.stringify(meta) } });
  }

  const mineDecision = plan.decisions.find(d => d.childTagId === tagId && d.applied);
  return mineDecision ? (tags.find((t: any) => t.id === mineDecision.parentTagId)?.identifier || '') : '';
}

function safeMeta(raw: unknown): any {
  if (raw && typeof raw === 'object') return raw as any;
  try { const v = JSON.parse(String(raw || '{}')); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; }
}
