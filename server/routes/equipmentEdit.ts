import type { Express, Request, Response } from 'express';
import { getPrisma, sendError } from '../context.js';
import { ROLES, roleById, roleFits, type RoleId } from '../../equipment/roles.js';
import { validateTag } from '../../equipment/tagPolicy.js';
import { policyOfProject } from './tagPolicy.js';
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
      const prisma = getPrisma();
      const me = authUserOf(req);
      const parent = await prisma.componentElement.findUnique({
        where: { id: req.params.id },
        include: { monoblock: { select: { id: true, systemId: true, system: { select: { projectId: true } } } } },
      });
      if (!parent) return res.status(404).json({ error: 'Позиция, внутрь которой добавляют, не найдена' });

      const name = String(req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: 'У позиции должно быть название' });
      const role = String(req.body?.role || 'ПРОЧЕЕ').trim() as RoleId;
      if (!ROLES.some(r => r.id === role)) {
        return res.status(400).json({ error: `Роли «${role}» нет в списке ролей` });
      }

      const projectId = parent.monoblock?.system?.projectId || '';
      const rawTag = String(req.body?.tag || '').trim();
      let tagId = '';
      if (rawTag) {
        const policy = await policyOfProject(projectId);
        const check = validateTag(rawTag, policy);
        if (!check.ok) {
          return res.status(400).json({ error: check.problem, fix: check.fix, field: 'tag' });
        }
        const existing = await prisma.tag.findFirst({
          where: { projectId, identifier: check.identifier },
          include: { componentElements: { select: { id: true, name: true } } },
        });
        if (existing) {
          const busy = (existing.componentElements || [])[0];
          if (busy) {
            return res.status(409).json({
              error: `Тег «${check.identifier}» уже привязан к «${busy.name}». Один тег — одно изделие.`,
              field: 'tag',
            });
          }
          tagId = existing.id;
        } else {
          const made = await prisma.tag.create({ data: { identifier: check.identifier, projectId } });
          tagId = made.id;
        }
      }

      // Код позиции строится от кода владельца и роли, а номер берётся первый
      // свободный: два датчика на одном двигателе — обычное дело
      const siblings = await prisma.componentElement.findMany({
        where: { monoblockId: parent.monoblockId },
        select: { itemCode: true, sourceOrder: true },
      });
      const taken = new Set(siblings.map((s: any) => s.itemCode));
      const base = `${parent.itemCode}/${role.toLowerCase()}`;
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
          monoblockId: parent.monoblockId,
          itemCode: `${base}${no}`,
          name,
          equipType: role,
          specs: JSON.stringify({ groups }),
          version: 1,
          status: 'OK',
          role,
          parentElementId: parent.id,
          sourceOrder: order,
          manual: true,
          createdById: me?.id || null,
          ...(tagId ? { tags: { connect: { id: tagId } } } : {}),
        },
      });

      // Родство тега: по тому же правилу, что и при импорте — тег ближайшего
      // тегированного владельца, а если такого нет, тег установки
      let parentTag = '';
      if (tagId) parentTag = await linkParentTag(prisma, projectId, created.id, tagId);

      const fits = roleFits(parent.role || 'БЛОК', role);
      res.json({
        ok: true,
        component: { id: created.id, itemCode: created.itemCode, name: created.name, role: created.role },
        parentTag,
        ...(fits ? {} : {
          warning: `Обычно «${roleById(role).title.toLowerCase()}» внутри «${roleById(parent.role || 'БЛОК').title.toLowerCase()}» не ставят.`
            + ' Позиция заведена — проверьте, что это именно то, что нужно.',
        }),
      });
    } catch (err: any) { sendError(res, err); }
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
