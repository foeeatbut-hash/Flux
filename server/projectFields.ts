/**
 * Поля данных проекта для файлов Flux Office: значение по ключу, поиск для
 * панели «Данные проекта», подписи.
 *
 * Ключ поля — договор office/fieldKeys.ts; значения тегов и оборудования —
 * те же правила, что у Конструктора (server/projectSlice.ts: ручные правки
 * инженера, алиасы параметров). Пустое значение в тексте — «—», а не пустота:
 * у поля Word без текста нечего выделить и не за что взяться, и оно
 * пропадает из документа для человека, хотя в файле стоит.
 */
import { getPrisma, resolveProjectId, upsertSetting } from './context.js';
import { parseKey, PROJECT_FIELDS, SIGN_ROLES, SIGN_TITLES, makeKey, type SignRole } from '../office/fieldKeys.js';
import {
  aliasMap, asCellValue, findElement, loadProjectAliases, loadProjectSlice, normalizeSpecs, resolveValue, type AliasMap,
} from './projectSlice.js';

const EMPTY = '—';

export const PROJECT_TITLES: Record<string, string> = {
  name: 'Название', code: 'Шифр', customer: 'Заказчик', contractor: 'Подрядчик', description: 'Примечание', status: 'Статус',
};
export const TAG_FIELDS: [string, string][] = [
  ['identifier', 'Тег'], ['brand', 'Марка'], ['department', 'Отдел'], ['wbs', 'WBS'], ['fluid', 'Среда'],
  ['system.name', 'Система'], ['element.name', 'Оборудование'], ['element.equipType', 'Тип оборудования'],
];
export const ELEMENT_FIELDS: [string, string][] = [
  ['name', 'Наименование'], ['itemCode', 'Код позиции'], ['equipType', 'Тип оборудования'], ['system.name', 'Система'],
  ['tag', 'Тег'], ['parentTag', 'Тег родителя'], ['model', 'Модель'], ['classTitle', 'Тип'],
];
export const VDR_FIELDS: [string, string][] = [
  ['code', 'Шифр подрядчика'], ['title', 'Наименование'], ['titleEn', 'Наименование (англ.)'], ['revision', 'Ревизия'],
  ['status', 'Статус'], ['issueDate', 'Дата выпуска'], ['ownerNo', 'Шифр заказчика'], ['vendorNo', 'Шифр поставщика'],
];
const DOC_FIELDS: [string, string][] = [['name', 'Имя файла'], ['code', 'Шифр'], ['revision', 'Ревизия'], ['title', 'Наименование']];
const VDR_STATUS: Record<string, string> = { DRAFT: 'Черновик', READY: 'Готов', REMARKS: 'Замечания', ACCEPTED: 'Принят' };

const ruDate = (d: Date | string | null | undefined) => (d ? new Date(d).toLocaleDateString('ru-RU') : '');

/** «Иванов И.И.» — так подписываются в штампе; нет частей — полное имя */
export function shortName(u: { name?: string | null; lastName?: string | null; firstName?: string | null; middleName?: string | null } | null): string {
  if (!u) return '';
  const last = String(u.lastName || '').trim();
  const ini = [u.firstName, u.middleName].map((s) => String(s || '').trim()).filter(Boolean).map((s) => `${s[0]}.`).join('');
  if (last) return ini ? `${last} ${ini}` : last;
  return String(u.name || '').trim();
}

/** Проект файла: папка проекта; общий диск и стол — проект, из которого работают */
export async function projectOfFile(fileId: string, fallback: string): Promise<string> {
  const prisma = getPrisma();
  const file = fileId ? await prisma.fileNode.findUnique({ where: { id: fileId }, select: { folder: { select: { projectId: true } } } }) : null;
  const pid = (file as any)?.folder?.projectId as string | undefined;
  if (pid) {
    const p = await prisma.project.findUnique({ where: { id: pid }, select: { system: true } }).catch(() => null);
    if (p && !(p as any).system) return pid;
  }
  return resolveProjectId(fallback);
}

// ── Подписи ──

const signersKey = (fileId: string) => `office_signers:${fileId}`;

export interface Signer { userId: string; name: string; date: string; source: 'file' | 'vdr' | 'author' }

/** Строка ВДР, к которой привязан файл */
async function vdrItemOf(fileId: string): Promise<any | null> {
  if (!fileId) return null;
  return getPrisma().docRegisterItem.findFirst({
    where: { fileNodeId: fileId },
    include: { register: { select: { preparedById: true, checkedById: true, approvedById: true } } },
  }).catch(() => null);
}

/**
 * Кто подписывает файл. Выбранное в панели — главное; нет — подписанты
 * реестра ВДР, к строке которого привязан файл (сменили проверяющего в
 * реестре — сменится и подпись); «Разработал» без того и другого — автор файла
 */
export async function signersOf(fileId: string): Promise<Partial<Record<SignRole, Signer>>> {
  const prisma = getPrisma();
  const out: Partial<Record<SignRole, Signer>> = {};
  if (!fileId) return out;
  let chosen: Record<string, { userId: string; date: string }> = {};
  const row = await prisma.appSetting.findFirst({ where: { key: signersKey(fileId), userId: null } });
  if (row) { try { chosen = JSON.parse(row.value) || {}; } catch { chosen = {}; } }
  const item = await vdrItemOf(fileId);
  const file = await prisma.fileNode.findUnique({ where: { id: fileId }, select: { createdById: true } });
  const want: Partial<Record<SignRole, { userId: string; date: string; source: Signer['source'] }>> = {};
  for (const role of SIGN_ROLES) {
    const c = chosen[role];
    const fromVdr = item?.register?.[`${role}ById`];
    if (c?.userId) want[role] = { userId: c.userId, date: c.date || '', source: 'file' };
    else if (fromVdr) want[role] = { userId: String(fromVdr), date: ruDate(item?.issueDate), source: 'vdr' };
    else if (role === 'prepared' && file?.createdById) want[role] = { userId: file.createdById, date: '', source: 'author' };
  }
  const ids = [...new Set(Object.values(want).map((w) => w!.userId))];
  const users = ids.length ? await prisma.user.findMany({
    where: { id: { in: ids } }, select: { id: true, name: true, lastName: true, firstName: true, middleName: true },
  }) : [];
  for (const role of SIGN_ROLES) {
    const w = want[role];
    if (!w) continue;
    const u = users.find((x: any) => x.id === w.userId);
    if (u) out[role] = { userId: w.userId, name: shortName(u), date: w.date, source: w.source };
  }
  return out;
}

/** Выбрать подписанта файла. Дата — сегодняшняя: день, когда человек встал в штамп */
export async function setSigner(fileId: string, role: SignRole, userId: string | null): Promise<void> {
  const prisma = getPrisma();
  const row = await prisma.appSetting.findFirst({ where: { key: signersKey(fileId), userId: null } });
  let all: Record<string, any> = {};
  if (row) { try { all = JSON.parse(row.value) || {}; } catch { all = {}; } }
  if (userId) all[role] = { userId, date: ruDate(new Date()) };
  else delete all[role];
  await upsertSetting(signersKey(fileId), null, JSON.stringify(all));
}

// ── Значения по ключам ──

export interface ResolveCtx { projectId: string; fileId?: string }

/** Значения ключей; незнакомый ключ — пропущен (такое поле не трогаем) */
export async function resolveKeys(keys: string[], ctx: ResolveCtx): Promise<Record<string, string | number>> {
  const prisma = getPrisma();
  const out: Record<string, string | number> = {};
  const refs = [...new Set(keys)].map((k) => [k, parseKey(k)] as const).filter(([, r]) => r);
  if (!refs.length) return out;
  const kinds = new Set(refs.map(([, r]) => r!.kind));
  const project = kinds.has('project') ? await prisma.project.findUnique({ where: { id: ctx.projectId } }) : null;
  const slice = kinds.has('tag') || kinds.has('el') ? await loadProjectSlice(ctx.projectId) : null;
  const aliases: AliasMap = slice ? aliasMap(await loadProjectAliases(ctx.projectId)) : {};
  const signers = kinds.has('sign') ? await signersOf(ctx.fileId || '') : {};
  const item = kinds.has('doc') ? await vdrItemOf(ctx.fileId || '') : null;
  const file = kinds.has('doc') && ctx.fileId ? await prisma.fileNode.findUnique({ where: { id: ctx.fileId }, select: { name: true } }) : null;
  const vdrItems = new Map<string, any>();
  const text = (v: string) => (v === '' ? EMPTY : v);
  for (const [key, ref] of refs) {
    const r = ref!;
    switch (r.kind) {
      case 'today': out[key] = ruDate(new Date()); break;
      case 'year': out[key] = new Date().getFullYear(); break;
      case 'project': out[key] = project ? text(String((project as any)[r.path] ?? '')) : '#НЕТ_ПРОЕКТА'; break;
      case 'doc': {
        const bare = String(file?.name || '').replace(/\.[^.]+$/, '');
        if (r.path === 'name') out[key] = text(bare);
        else if (!item) out[key] = '#НЕТ_ВДР';
        else if (r.path === 'code') out[key] = text(item.contractorNo || item.ownerNo || '');
        else if (r.path === 'revision') out[key] = text(item.revision || '');
        else if (r.path === 'title') out[key] = text(item.titleRu || item.titleEn || bare);
        break;
      }
      case 'sign': {
        const s = signers[r.role];
        out[key] = s ? text(r.path === 'name' ? s.name : s.date) : EMPTY;
        break;
      }
      case 'tag': {
        const id = r.id.toLowerCase();
        const tag = slice!.tags.find((t: any) => t.id === r.id || String(t.identifier).toLowerCase() === id);
        out[key] = tag ? asCellValue(text(resolveValue('tag', tag, r.path, aliases))) : '#НЕТ_ТЕГА';
        break;
      }
      case 'el': {
        const el = findElement(slice!.elements, r.id);
        out[key] = el ? asCellValue(text(resolveValue('element', el, r.path, aliases))) : '#НЕТ_ЭЛЕМЕНТА';
        break;
      }
      case 'vdr': {
        if (!vdrItems.has(r.id)) {
          vdrItems.set(r.id, await prisma.docRegisterItem.findFirst({
            where: { projectId: ctx.projectId, OR: [{ contractorNo: r.id }, { ownerNo: r.id }, { vendorNo: r.id }] },
          }).catch(() => null));
        }
        const it = vdrItems.get(r.id);
        out[key] = it ? text(vdrValue(it, r.path)) : '#НЕТ_ВДР';
        break;
      }
    }
  }
  return out;
}

function vdrValue(it: any, path: string): string {
  switch (path) {
    case 'code': return String(it.contractorNo || '');
    case 'title': return String(it.titleRu || it.titleEn || '');
    case 'status': return VDR_STATUS[it.status] || String(it.status || '');
    case 'issueDate': return ruDate(it.issueDate);
    default: return typeof it[path] === 'string' ? it[path] : '';
  }
}

// ── Поиск для панели ──

export interface PanelField { key: string; title: string; value: string }
export interface PanelItem { id: string; title: string; hint: string; fields: PanelField[] }
export interface PanelGroup { id: 'project' | 'doc' | 'tag' | 'el' | 'vdr'; title: string; items: PanelItem[] }

const LIMIT = 15;
const show = (v: unknown) => (v === '' || v == null ? EMPTY : String(v));

/** Параметры оборудования элемента: «Группа | Ключ» с ручными правками */
function paramFields(el: any, key: (path: string) => string, aliases: AliasMap): PanelField[] {
  const out: PanelField[] = [];
  for (const g of normalizeSpecs(el.specs).groups) {
    for (const p of g.params || []) {
      if (!p.key) continue;
      const path = `param:${g.title}|${p.key}`;
      const v = resolveValue('element', el, path, aliases);
      if (v === '') continue;
      out.push({ key: key(path), title: `${g.title} · ${p.key}${p.unit ? `, ${p.unit}` : ''}`, value: v });
    }
  }
  return out.slice(0, 60);
}

/**
 * Поиск по данным проекта: поля проекта и документа, теги, оборудование,
 * строки ВДР. Каждая находка — со своими полями, готовыми ключами и
 * сегодняшними значениями: человек видит, что вставит
 */
export async function searchProject(q: string, ctx: ResolveCtx): Promise<PanelGroup[]> {
  const prisma = getPrisma();
  const needle = q.trim().toLowerCase();
  const hit = (...vals: unknown[]) => !needle || vals.some((v) => String(v ?? '').toLowerCase().includes(needle));
  const groups: PanelGroup[] = [];

  const projectKeys = PROJECT_FIELDS.map((f) => `project.${f}`);
  const docKeys = DOC_FIELDS.map(([f]) => `doc.${f}`);
  const values = await resolveKeys([...projectKeys, ...docKeys], ctx);
  const pf = PROJECT_FIELDS.map((f) => ({ key: `project.${f}`, title: PROJECT_TITLES[f], value: show(values[`project.${f}`]) }))
    .filter((f) => hit(f.title, f.value));
  if (pf.length) groups.push({ id: 'project', title: 'Проект', items: [{ id: 'project', title: 'Проект', hint: '', fields: pf }] });
  const df = DOC_FIELDS.map(([f, title]) => ({ key: `doc.${f}`, title, value: show(values[`doc.${f}`]) }))
    .filter((f) => !String(f.value).startsWith('#') && hit(f.title, f.value));
  if (df.length && ctx.fileId) groups.push({ id: 'doc', title: 'Документ', items: [{ id: 'doc', title: 'Этот файл', hint: '', fields: df }] });

  const slice = await loadProjectSlice(ctx.projectId);
  const aliases = aliasMap(await loadProjectAliases(ctx.projectId));
  const tags = slice.tags.filter((t: any) => hit(t.identifier, t.brand, t.componentElements?.[0]?.name)).slice(0, LIMIT);
  if (tags.length) {
    groups.push({
      id: 'tag', title: 'Теги', items: tags.map((t: any) => {
        const key = (path: string) => makeKey('tag', t.id, path);
        const base = TAG_FIELDS.map(([path, title]) => ({ key: key(path), title, value: show(resolveValue('tag', t, path, aliases)) }));
        // Параметры тега — от его оборудования: так их видит и Конструктор
        const params = (t.componentElements || []).slice(0, 1).flatMap((el: any) => paramFields(el, key, aliases));
        return { id: t.id, title: t.identifier, hint: String(t.componentElements?.[0]?.name || t.brand || ''), fields: [...base, ...params] };
      }),
    });
  }
  const els = slice.elements.filter((e: any) => e.itemCode || e.name).filter((e: any) => hit(e.itemCode, e.name, e.equipType)).slice(0, LIMIT);
  if (els.length) {
    groups.push({
      id: 'el', title: 'Оборудование', items: els.map((e: any) => {
        const code = String(e.itemCode || e.name);
        const key = (path: string) => makeKey('el', code, path);
        const base = ELEMENT_FIELDS.map(([path, title]) => ({ key: key(path), title, value: show(resolveValue('element', e, path, aliases)) }));
        return { id: e.id, title: code, hint: e.itemCode ? String(e.name || '') : String(e._system?.name || ''), fields: [...base, ...paramFields(e, key, aliases)] };
      }),
    });
  }
  const vdr = await prisma.docRegisterItem.findMany({
    where: { projectId: ctx.projectId }, orderBy: { contractorNo: 'asc' }, take: 2000,
  }).catch(() => [] as any[]);
  const vdrHits = vdr.filter((it: any) => (it.contractorNo || it.ownerNo) && hit(it.contractorNo, it.ownerNo, it.vendorNo, it.titleRu, it.titleEn)).slice(0, LIMIT);
  if (vdrHits.length) {
    groups.push({
      id: 'vdr', title: 'ВДР', items: vdrHits.map((it: any) => {
        const code = String(it.contractorNo || it.ownerNo);
        return {
          id: it.id, title: code, hint: String(it.titleRu || it.titleEn || ''),
          fields: VDR_FIELDS.map(([path, title]) => ({ key: makeKey('vdr', code, path), title, value: show(vdrValue(it, path)) })),
        };
      }),
    });
  }
  return groups;
}

export const signTitle = (role: SignRole) => SIGN_TITLES[role];
