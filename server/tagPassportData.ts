/**
 * Паспорт тега: всё, что известно о теге, одним ответом.
 *
 * В программе пять разных «примечаний», и они не связаны между собой:
 * комментарии тега (metadata.descriptions), примечание закупки и отметки этапов
 * (metadata.procurement), замечания ВДР, заметки блокнота (связь по упоминанию
 * кода) и примечания САПР (ComponentElement.tagNotes). Паспорт собирает их в
 * один список и подписывает, откуда каждое. Они остаются раздельными по смыслу:
 * примечание закупки и комментарий к тегу — разные вещи, и склеивать их в одно
 * поле нельзя.
 *
 * Замечаний ВДР здесь нет: связь ВДР с тегом отключена (держалась на коде строкой,
 * и переименование её рвало). Вернуть — когда связь пойдёт по id тега.
 *
 * Чистая часть (`passportNotes`, `compositionOf`, `duplicatesOf`) не знает ни о
 * базе, ни о запросе — её проверяет scripts/test-tag-passport-data.ts без сервера.
 */

import { mentions, projectSnapshot, whereUsed, type NoteLite, type StageLite, type UsageGroup } from './insight.js';
import { parseMetadata } from './tagHistory.js';
import { normCode } from '../src/capture/recognize.js';

/** Откуда примечание: по этому полю окно рисует подпись и фильтр. */
export type NoteSource = 'tags' | 'procurement' | 'notebook' | 'cad';

export interface PassportNote {
  id: string;
  source: NoteSource;
  /** Подпись источника для человека: «Теги», «Закупка», «Заметки», «САПР» */
  sourceLabel: string;
  /** comment — комментарий тега; note — примечание закупки; stage — отметка этапа; mention — упоминание в заметке; evidence — разбор САПР */
  kind: 'comment' | 'note' | 'stage' | 'mention' | 'evidence';
  text: string;
  /** Пояснение к тексту: комментарий к описанию, причина решения САПР */
  detail?: string;
  /** Для комментария тега — «Проверить»/«Критично»…; для САПР — вердикт разбора */
  status?: string;
  author: string;
  /** ISO; пусто, если дата неизвестна */
  at: string | null;
  /** Правился позже, чем создан */
  editedBy?: string;
  editedAt?: string | null;
  /** Куда ведёт нажатие; пусто — у записи нет своего экрана */
  route: string;
}

const SOURCE_LABEL: Record<NoteSource, string> = { tags: 'Теги', procurement: 'Закупка', notebook: 'Заметки', cad: 'САПР' };

const iso = (v: unknown): string | null => {
  if (!v) return null;
  const t = new Date(v as any).getTime();
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** Кусок текста заметки вокруг первого упоминания кода. */
export function excerptAround(text: string, code: string, width = 160): string {
  const flat = str(text).replace(/\s+/g, ' ').trim();
  if (flat.length <= width) return flat;
  const at = flat.toLowerCase().indexOf(str(code).toLowerCase());
  const from = Math.max(0, (at < 0 ? 0 : at) - Math.floor(width / 3));
  const cut = flat.slice(from, from + width).trim();
  return `${from > 0 ? '…' : ''}${cut}${from + width < flat.length ? '…' : ''}`;
}

export interface CadEvidenceSource {
  elementId: string;
  elementName: string;
  tagNotes: unknown;
  at: string | null;
}

export interface NotesInput {
  tagId: string;
  code: string;
  meta: Record<string, any>;
  stages: StageLite[];
  /** Заметки блокнота, уже отобранные по правам (свои и общие) */
  notebook: NoteLite[];
  cad: CadEvidenceSource[];
  /** Когда и кем записано нынешнее примечание закупки — из истории тега */
  procNoteSetBy?: { by: string; at: string | null } | null;
}

const VERDICT_LABEL: Record<string, string> = { assigned: 'назначен', 'no-slot': 'нет места', invalid: 'не принят' };

/**
 * Примечания всех источников одним списком, новые сверху. Записи без даты — в
 * конце: сортировать по пустому значению значило бы поставить их первыми.
 */
export function passportNotes(input: NotesInput): PassportNote[] {
  const out: PassportNote[] = [];
  const { meta, tagId, code } = input;

  const descriptions = Array.isArray(meta.descriptions) ? meta.descriptions : [];
  descriptions.forEach((d: any, i: number) => {
    const text = str(d?.text).trim();
    const detail = str(d?.comment).trim();
    if (!text && !detail) return;
    const createdAt = iso(d?.createdAt);
    const editedAt = iso(d?.updatedAt);
    out.push({
      id: `tags:${str(d?.id) || i}`, source: 'tags', sourceLabel: SOURCE_LABEL.tags, kind: 'comment',
      text: text || detail, detail: text ? detail || undefined : undefined, status: str(d?.status) || undefined,
      author: str(d?.createdBy), at: createdAt,
      ...(editedAt && editedAt !== createdAt ? { editedBy: str(d?.updatedBy), editedAt } : {}),
      route: `/registry?tag=${encodeURIComponent(code)}`,
    });
  });

  const proc = meta.procurement && typeof meta.procurement === 'object' ? meta.procurement : {};
  // Менеджмент по тегу не фильтруется: ведёт на сам экран, нужная строка находится там
  const procRoute = '/management';
  if (str(proc.note).trim()) {
    out.push({
      id: `procurement:note:${tagId}`, source: 'procurement', sourceLabel: SOURCE_LABEL.procurement, kind: 'note',
      text: str(proc.note).trim(), author: input.procNoteSetBy?.by || '', at: input.procNoteSetBy?.at || null, route: procRoute,
    });
  }
  const log = proc.stageLog && typeof proc.stageLog === 'object' ? proc.stageLog : {};
  const labelOf = (id: string) => input.stages.find((s) => s.id === id)?.label || id;
  for (const [stageId, rec] of Object.entries<any>(log)) {
    out.push({
      id: `procurement:stage:${stageId}`, source: 'procurement', sourceLabel: SOURCE_LABEL.procurement, kind: 'stage',
      text: `Этап «${labelOf(stageId)}»`, author: str(rec?.by), at: iso(rec?.at), route: procRoute,
    });
  }

  for (const n of input.notebook) {
    if (!mentions(n.title, code) && !mentions(n.text, code)) continue;
    out.push({
      id: `notebook:${n.id}`, source: 'notebook', sourceLabel: SOURCE_LABEL.notebook, kind: 'mention',
      text: excerptAround(mentions(n.text, code) ? n.text : n.title, code), detail: n.title || undefined,
      author: '', at: n.updatedAt || null, route: `/notes?note=${encodeURIComponent(n.id)}`,
    });
  }

  for (const src of input.cad) {
    let list: any[] = [];
    try { const v = typeof src.tagNotes === 'string' ? JSON.parse(src.tagNotes) : src.tagNotes; if (Array.isArray(v)) list = v; } catch { /* не JSON */ }
    list.forEach((e, i) => {
      const phrase = str(e?.phrase).trim();
      const why = str(e?.why).trim();
      if (!phrase && !why) return;
      out.push({
        id: `cad:${src.elementId}:${i}`, source: 'cad', sourceLabel: SOURCE_LABEL.cad, kind: 'evidence',
        text: phrase || why, detail: [str(e?.identifier), phrase ? why : ''].filter(Boolean).join(' — ') || undefined,
        status: VERDICT_LABEL[str(e?.verdict)] || str(e?.verdict) || undefined,
        author: src.elementName, at: src.at, route: `/equipment?element=${encodeURIComponent(src.elementId)}`,
      });
    });
  }

  return out.sort((a, b) => {
    if (a.at && b.at) return b.at.localeCompare(a.at);
    if (a.at) return -1;
    if (b.at) return 1;
    return 0;
  });
}

// ── Родитель, состав, дубли ──────────────────────────────────────────────────

export interface TagRef { id: string; identifier: string; mainName: string }
export interface CompositionNode extends TagRef { children: TagRef[] }
export interface Composition { parent: TagRef | null; children: CompositionNode[] }

interface TagRow { id: string; identifier: string; metadata?: unknown }

const refOf = (t: TagRow): TagRef => ({ id: t.id, identifier: t.identifier, mainName: str(parseMetadata(t.metadata).mainName) });

/**
 * Родитель и состав на два уровня. Связь хранится с двух сторон (parentId у
 * потомка, connections у родителя) и в старых данных бывает записана только с
 * одной, поэтому читаются обе.
 */
export function compositionOf(tag: TagRow, all: TagRow[]): Composition {
  const byId = new Map(all.map((t) => [t.id, t]));
  const meta = new Map(all.map((t) => [t.id, parseMetadata(t.metadata)]));
  const childIdsOf = (id: string): string[] => {
    const ids = new Set<string>();
    const own = meta.get(id)?.connections;
    for (const c of Array.isArray(own) ? own : []) if (byId.has(String(c))) ids.add(String(c));
    for (const [otherId, m] of meta) if (m.parentId === id) ids.add(otherId);
    ids.delete(id);
    return [...ids];
  };
  const parentId = str(meta.get(tag.id)?.parentId);
  const parentRow = (parentId && byId.get(parentId)) || all.find((t) => t.id !== tag.id && childIdsOf(t.id).includes(tag.id));
  const sortRef = (a: TagRef, b: TagRef) => a.identifier.localeCompare(b.identifier, 'ru');
  const children = childIdsOf(tag.id).map((id) => byId.get(id)!).map((row) => ({
    ...refOf(row),
    // Потомок не должен вернуть в состав самого тега или его родителя: цикл в данных — не повод зациклить окно
    children: childIdsOf(row.id).filter((id) => id !== tag.id && id !== parentRow?.id).map((id) => refOf(byId.get(id)!)).sort(sortRef),
  })).sort(sortRef);
  return { parent: parentRow ? refOf(parentRow) : null, children };
}

/**
 * Другие теги проекта с тем же кодом. Сравнение — по строению кода, а не
 * побуквенно: `AHU-2`, `AHU 2` и `АНU-2` (русская «А», «Н») — один код, а
 * `бл2.1` и `бл21` — разные (normCode хранит разделитель между цифрами).
 */
export function duplicatesOf(tag: TagRow, all: TagRow[]): TagRef[] {
  const key = normCode(tag.identifier);
  if (!key) return [];
  return all.filter((t) => t.id !== tag.id && normCode(t.identifier) === key).map(refOf);
}

// ── Сборка из базы ───────────────────────────────────────────────────────────

export interface PassportOptions { userId?: string; mailAccountIds?: string[] }

/** Строка закупки для шапки блока «Закупка» */
export interface ProcurementView {
  stageId: string; stageLabel: string; supplier: string; qty: string; note: string; templateId: string;
  /** Отметки этапов, по порядку этапов проекта */
  stageLog: Array<{ id: string; label: string; at: string | null; by: string }>;
}

export function procurementView(meta: Record<string, any>, stages: StageLite[]): ProcurementView {
  const proc = meta.procurement && typeof meta.procurement === 'object' ? meta.procurement : {};
  const labelOf = (id: string) => stages.find((s) => s.id === id)?.label || id;
  const log = proc.stageLog && typeof proc.stageLog === 'object' ? proc.stageLog : {};
  const stageId = str(proc.stage) || stages[0]?.id || '';
  const order = (id: string) => { const i = stages.findIndex((s) => s.id === id); return i < 0 ? 999 : i; };
  return {
    stageId, stageLabel: labelOf(stageId), supplier: str(proc.supplier), qty: str(proc.qty), note: str(proc.note), templateId: str(proc.templateId),
    stageLog: Object.entries<any>(log).map(([id, r]) => ({ id, label: labelOf(id), at: iso(r?.at), by: str(r?.by) })).sort((a, b) => order(a.id) - order(b.id)),
  };
}

export interface PassportResult {
  tag: {
    id: string; projectId: string; projectName: string; identifier: string; brand: string; department: string; wbs: string; fluid: string;
    mainName: string; actuality: string; createdAt: string | null; updatedAt: string | null;
  };
  notes: PassportNote[];
  procurement: ProcurementView;
  composition: Composition;
  duplicates: TagRef[];
  /** whereUsed тега без группы ВДР */
  usage: { found: boolean; total: number; groups: UsageGroup[] };
}

/**
 * Собрать паспорт. Права проверяет вызывающий (проект тега) — здесь только то,
 * что видно этому человеку: личные заметки и письма берутся по `userId` и
 * `mailAccountIds`, как в «Где используется».
 */
export async function buildPassport(prisma: any, tagRow: any, opts: PassportOptions, history: Array<{ at: string; field: string; after: string | null; userName: string }>): Promise<PassportResult> {
  const projectId = String(tagRow.projectId);
  const snap = await projectSnapshot(prisma, projectId, { userId: opts.userId, mailAccountIds: opts.mailAccountIds });
  const usage = whereUsed(snap, 'tag', tagRow.id);
  const elementIds = (usage.groups.find((g) => g.id === 'elements')?.links || []).map((l) => l.id);
  const cadRows: any[] = elementIds.length
    ? await prisma.componentElement.findMany({ where: { id: { in: elementIds } }, select: { id: true, name: true, itemCode: true, tagNotes: true, updatedAt: true } }).catch(() => [])
    : [];
  const all: TagRow[] = await prisma.tag.findMany({ where: { projectId }, select: { id: true, identifier: true, metadata: true } });

  const meta = parseMetadata(tagRow.metadata);
  // Кто и когда записал нынешнее примечание закупки: сам тег этого не помнит, помнит история
  const noteNow = str(meta.procurement?.note);
  const noteRow = noteNow ? history.find((h) => h.field === 'procurement.note' && h.after === noteNow) : undefined;

  return {
    tag: {
      id: tagRow.id, projectId, projectName: snap.projectName, identifier: str(tagRow.identifier), brand: str(tagRow.brand),
      department: str(tagRow.department), wbs: str(tagRow.wbs), fluid: str(tagRow.fluid),
      mainName: str(meta.mainName), actuality: snap.tags.find((t) => t.id === tagRow.id)?.actuality || 'draft',
      createdAt: iso(tagRow.createdAt), updatedAt: iso(tagRow.updatedAt),
    },
    notes: passportNotes({
      tagId: tagRow.id, code: str(tagRow.identifier), meta, stages: snap.stages, notebook: snap.notes,
      cad: cadRows.map((r) => ({ elementId: r.id, elementName: str(r.itemCode || r.name), tagNotes: r.tagNotes, at: iso(r.updatedAt) })),
      procNoteSetBy: noteRow ? { by: noteRow.userName, at: noteRow.at } : null,
    }),
    procurement: procurementView(meta, snap.stages),
    composition: compositionOf({ id: tagRow.id, identifier: tagRow.identifier, metadata: tagRow.metadata }, all),
    duplicates: duplicatesOf({ id: tagRow.id, identifier: tagRow.identifier }, all),
    usage: { found: usage.found, total: usage.total, groups: usage.groups },
  };
}
