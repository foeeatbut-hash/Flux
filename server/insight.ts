/**
 * Связи проекта: срез данных, поиск упоминаний и ответ на вопрос «где это
 * используется».
 *
 * Зачем отдельный слой. Данные проекта лежат по разделам и друг о друге не
 * знают: тег — в реестре, элемент — в оборудовании, документ — в Конструкторе,
 * строка — в ВДР, файл — в Проводнике. Инженеру нужен обратный ход: «я меняю
 * расход у AHU-2 — где это вылезет». Собрать такой ответ можно только сверху,
 * поэтому здесь один срез проекта, а разделы не трогаются.
 *
 * Разбор данных (что такое «параметр», «этап», «упоминание») живёт здесь же,
 * чтобы правила проверки и лист изменений считали то же самое, что и панель
 * связей. Расхождение между ними было бы хуже отсутствия обеих.
 */

import { overrideKey } from './specUtils.js';

// ── Что такое «слово» при поиске обозначений ────────────────────────────────
// В JS \b и \w не считают кириллицу словом, поэтому границы задаются явно.
// Иначе «бл2.1» находится внутри «бл2.11», а «AHU-2» — внутри «AHU-21»: обе
// ошибки уже случались в этом проекте на разных подсистемах.
const WORD_CHARS = 'A-Za-zА-Яа-яЁё0-9';

/** Есть ли в тексте отдельное упоминание кода (а не кусок другого кода) */
export function mentions(text: string, code: string): boolean {
  if (!text || !code) return false;
  const esc = String(code).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!esc) return false;
  // Точка с цифрой после кода — тоже продолжение: «бл2.1» ≠ «бл2.1.3»
  const re = new RegExp(`(?<![${WORD_CHARS}])${esc}(?![${WORD_CHARS}]|\\.\\d)`, 'iu');
  return re.test(text);
}

/** Сколько раз код упомянут — для «в документе 12 раз» */
export function countMentions(text: string, code: string): number {
  if (!text || !code) return 0;
  const esc = String(code).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!esc) return 0;
  const re = new RegExp(`(?<![${WORD_CHARS}])${esc}(?![${WORD_CHARS}]|\\.\\d)`, 'giu');
  return (text.match(re) || []).length;
}

// ── Формы среза ─────────────────────────────────────────────────────────────

export interface ParamLite { group: string; key: string; value: string; unit: string }

export interface TagLite {
  id: string; identifier: string; brand: string; department: string; wbs: string; fluid: string;
  mainName: string;
  stageId: string; stageLabel: string; stageSince: string | null; stageIsFirst: boolean; stageIsFinal: boolean;
  actuality: string; supplier: string; qty: string;
  updatedAt: string | null;
}

export interface ElementLite {
  id: string; name: string; itemCode: string; equipType: string;
  systemId: string; systemName: string; monoblockName: string;
  status: string; hasConflict: boolean; conflictType: string;
  paramConflicts: { group: string; key: string; oldValue: string; newValue: string }[];
  params: ParamLite[];
  tagIds: string[]; tagCodes: string[];
  version: number; updatedAt: string | null;
}

export interface DocLite { id: string; name: string; kind: string; scope: string; text: string }
export interface FileLite {
  id: string; name: string; folderId: string | null; folderName: string; revision: string; statusCode: string;
  tagIds: string[]; refId: string | null; updatedAt: string | null;
}
export interface VdrLite {
  id: string; registerId: string; registerName: string; contractorNo: string; titleRu: string;
  vdrCode: string; revision: string; status: string; tagCodes: string[];
  docId: string | null; issueDate: string | null; dueDate: string | null;
}
export interface NoteLite { id: string; title: string; text: string }
export interface MailLite {
  id: string; accountId: string; folderId: string; threadKey: string;
  subject: string; from: string; text: string; sentAt: string | null;
}
export interface ChatLite { id: string; text: string; author: string; at: string | null; elementId: string | null }

export interface StageLite { id: string; label: string }

export interface ProjectSnapshot {
  projectId: string;
  projectName: string;
  /** Все проекты — нужны общему поиску: «перейти в проект» ищут там же */
  projects: { id: string; name: string }[];
  tags: TagLite[];
  elements: ElementLite[];
  docs: DocLite[];
  files: FileLite[];
  vdr: VdrLite[];
  notes: NoteLite[];
  chat: ChatLite[];
  mail: MailLite[];
  stages: StageLite[];
}

// ── Разбор JSON-полей ───────────────────────────────────────────────────────

const safeJson = (raw: any, fallback: any) => {
  if (raw == null || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch (_) { return fallback; }
};

/** Характеристики элемента из JSON specs с наложенными ручными правками */
export function paramsOf(specs: any, overrides: any): ParamLite[] {
  const parsed = safeJson(specs, null);
  const over = safeJson(overrides, {}) || {};
  const groups = Array.isArray(parsed?.groups) ? parsed.groups : [];
  const out: ParamLite[] = [];
  for (const g of groups) {
    const group = String(g?.title || '');
    for (const p of (g?.params || [])) {
      if (!p?.key) continue;
      const key = String(p.key);
      // Ручное переопределение сильнее импортированного значения — так же
      // считает и карточка оборудования, иначе проверка ругалась бы на
      // параметры, которые человек уже заполнил руками
      const manual = over[overrideKey(group, key)];
      out.push({
        group, key,
        value: String(manual !== undefined && manual !== null ? manual : (p.value ?? '')),
        unit: String(p.unit ?? ''),
      });
    }
  }
  return out;
}

/** Актуальность тега по его описаниям — та же лестница, что в реестре */
export function actualityOf(meta: any): string {
  const d = Array.isArray(meta?.descriptions) ? meta.descriptions : [];
  if (d.length === 0) return 'draft';
  for (const level of ['critical', 'warning', 'info', 'actual']) {
    if (d.some((x: any) => x?.status === level)) return level;
  }
  return 'draft';
}

/** Плоский текст HTML-заметки — по нему ищем упоминания */
export function plainText(html: string): string {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── Сбор среза из базы ──────────────────────────────────────────────────────

export interface SnapshotOptions {
  /** Тексты документов Конструктора нужны только для поиска упоминаний */
  withDocText?: boolean;
  /** Кому отдаём: личные документы и заметки чужими не показываем */
  userId?: string;
  /**
   * Ящики, доступные этому человеку (свои личные и общий). Считает вызывающий
   * через readableAccounts: письма — личная переписка, и решать, что из них
   * видно, должна почта, а не панель связей.
   */
  mailAccountIds?: string[];
}

const DEFAULT_STAGES: StageLite[] = [
  { id: 'added', label: 'Добавлен' }, { id: 'ordered', label: 'Заказан' },
  { id: 'approved', label: 'Утверждён' }, { id: 'purchased', label: 'Куплен' },
];

export async function projectSnapshot(prisma: any, projectId: string, opts: SnapshotOptions = {}): Promise<ProjectSnapshot> {
  const uid = opts.userId || '';
  const [project, allProjects, stageSetting, tags, systems, docs, files, registers, notes, mail, chat] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true } }).catch(() => null),
    prisma.project.findMany({ select: { id: true, name: true } }).catch(() => []),
    prisma.appSetting.findFirst({ where: { key: 'procurement_stages', userId: null } }).catch(() => null),
    prisma.tag.findMany({ where: { projectId } }),
    prisma.equipmentSystem.findMany({
      where: { projectId },
      include: { monoblocks: { include: { components: { include: { tags: { select: { id: true, identifier: true } } } } } } },
    }),
    prisma.constructorDoc.findMany({
      where: { projectId, deletedAt: null, OR: [{ scope: 'SHARED' }, { ownerId: uid }] },
      select: { id: true, name: true, kind: true, scope: true, workbook: opts.withDocText === true, bindings: opts.withDocText === true },
    }),
    prisma.fileNode.findMany({
      where: {
        deletedAt: null, type: { not: 'CHAT_FILE' },
        folder: { projectId },
        OR: [{ scope: { not: 'PERSONAL' } }, { ownerId: uid }],
      },
      select: {
        id: true, name: true, revision: true, statusCode: true, refId: true, updatedAt: true,
        folder: { select: { id: true, name: true } },
        mainTags: { select: { id: true } }, additionalTags: { select: { id: true } },
      },
      take: 3000,
    }),
    prisma.docRegister.findMany({ where: { projectId }, include: { items: true } }).catch(() => []),
    prisma.userNote.findMany({
      where: { OR: [{ ownerId: uid }, { ownerId: null }] },
      select: { id: true, title: true, content: true }, take: 300,
    }).catch(() => []),
    // Переписка — личная. Берём только то, что этот человек и так видит: свои
    // сообщения, адресованные ему и группы, где он состоит. Иначе панель
    // связей стала бы дырой в приватности чата.
    (opts.mailAccountIds && opts.mailAccountIds.length
      ? prisma.mailMessage.findMany({
        where: { accountId: { in: opts.mailAccountIds } },
        select: {
          id: true, accountId: true, folderId: true, threadKey: true,
          subject: true, fromName: true, fromAddr: true, snippet: true, bodyText: true, sentAt: true,
        },
        orderBy: { sentAt: 'desc' }, take: 800,
      })
      : Promise.resolve([])).catch(() => []),
    prisma.chatMessage.findMany({
      where: {
        OR: [
          { senderId: uid }, { receiverId: uid },
          { chatGroup: { members: { some: { id: uid } } } },
        ],
      },
      select: {
        id: true, content: true, createdAt: true, linkedElementId: true,
        sender: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' }, take: 600,
    }).catch(() => []),
  ]);

  let stages = DEFAULT_STAGES;
  const parsedStages = safeJson(stageSetting?.value, null);
  if (Array.isArray(parsedStages) && parsedStages.length) {
    stages = parsedStages.map((s: any) => ({ id: String(s.id), label: String(s.label || s.id) }));
  }
  const stageIds = stages.map(s => s.id);

  const tagsLite: TagLite[] = (tags || []).map((t: any) => {
    const meta = safeJson(t.metadata, {}) || {};
    const proc = meta.procurement || {};
    let idx = proc.stage ? stageIds.indexOf(proc.stage) : 0;
    if (idx < 0) idx = 0;
    const stageRec = (proc.stageLog || {})[stages[idx]?.id] || null;
    return {
      id: t.id, identifier: String(t.identifier || ''),
      brand: String(t.brand || ''), department: String(t.department || ''),
      wbs: String(t.wbs || ''), fluid: String(t.fluid || ''),
      mainName: String(meta.mainName || ''),
      stageId: stages[idx]?.id || 'added', stageLabel: stages[idx]?.label || 'Добавлен',
      stageSince: stageRec?.at || (t.createdAt ? new Date(t.createdAt).toISOString() : null),
      stageIsFirst: idx === 0, stageIsFinal: idx >= stages.length - 1,
      actuality: actualityOf(meta),
      supplier: String(proc.supplier || ''), qty: String(proc.qty || ''),
      updatedAt: t.updatedAt ? new Date(t.updatedAt).toISOString() : null,
    };
  });

  const elements: ElementLite[] = [];
  for (const sys of (systems || [])) {
    for (const mono of (sys.monoblocks || [])) {
      for (const c of (mono.components || [])) {
        elements.push({
          id: c.id, name: String(c.name || ''), itemCode: String(c.itemCode || c.name || ''),
          equipType: String(c.equipType || 'ПРОЧЕЕ'),
          systemId: sys.id, systemName: String(sys.name || ''), monoblockName: String(mono.name || ''),
          status: String(c.status || 'OK'),
          hasConflict: !!c.hasConflict, conflictType: String(c.conflictType || ''),
          paramConflicts: Array.isArray(safeJson(c.paramConflicts, [])) ? safeJson(c.paramConflicts, []) : [],
          params: paramsOf(c.specs, c.overrides),
          tagIds: (c.tags || []).map((t: any) => t.id),
          tagCodes: (c.tags || []).map((t: any) => String(t.identifier || '')),
          version: Number(c.version || 1),
          updatedAt: c.updatedAt ? new Date(c.updatedAt).toISOString() : null,
        });
      }
    }
  }

  const vdr: VdrLite[] = [];
  for (const reg of (registers || [])) {
    for (const it of (reg.items || [])) {
      vdr.push({
        id: it.id, registerId: reg.id, registerName: String(reg.name || 'ВДР'),
        contractorNo: String(it.contractorNo || ''), titleRu: String(it.titleRu || it.titleEn || ''),
        vdrCode: String(it.vdrCode || ''), revision: String(it.revision || ''),
        status: String(it.status || 'DRAFT'),
        tagCodes: (safeJson(it.equipmentTags, []) || []).map((x: any) => String(x)),
        docId: it.docId || null,
        issueDate: it.issueDate ? new Date(it.issueDate).toISOString() : null,
        dueDate: it.dueDate ? new Date(it.dueDate).toISOString() : null,
      });
    }
  }

  return {
    projectId,
    projectName: String(project?.name || ''),
    projects: (allProjects || []).map((p: any) => ({ id: p.id, name: String(p.name || '') })),
    tags: tagsLite,
    elements,
    docs: (docs || []).map((d: any) => ({
      id: d.id, name: String(d.name || ''), kind: String(d.kind || 'DOC'), scope: String(d.scope || 'SHARED'),
      // Снапшот книги и привязки — единственное место, где документ хранит
      // текст; ищем по ним обоим, иначе упоминание в формуле не находится
      text: opts.withDocText ? `${d.workbook || ''}\n${d.bindings || ''}` : '',
    })),
    files: (files || []).map((f: any) => ({
      id: f.id, name: String(f.name || ''),
      folderId: f.folder?.id || null, folderName: String(f.folder?.name || ''),
      revision: String(f.revision || ''), statusCode: String(f.statusCode || ''),
      tagIds: [...(f.mainTags || []), ...(f.additionalTags || [])].map((t: any) => t.id),
      refId: f.refId || null,
      updatedAt: f.updatedAt ? new Date(f.updatedAt).toISOString() : null,
    })),
    vdr,
    notes: (notes || []).map((n: any) => ({ id: n.id, title: String(n.title || ''), text: plainText(n.content) })),
    mail: (mail || []).map((m: any) => ({
      id: m.id, accountId: m.accountId, folderId: m.folderId, threadKey: String(m.threadKey || ''),
      subject: String(m.subject || ''),
      from: String(m.fromName || m.fromAddr || ''),
      // Тело подтягивается только при открытии письма — пока его нет, ищем по
      // теме и фрагменту, иначе связь нашлась бы лишь у прочитанных писем
      text: `${m.subject || ''} ${m.snippet || ''} ${m.bodyText || ''}`,
      sentAt: m.sentAt ? new Date(m.sentAt).toISOString() : null,
    })),
    chat: (chat || []).map((m: any) => ({
      id: m.id, text: plainText(m.content), author: String(m.sender?.name || ''),
      at: m.createdAt ? new Date(m.createdAt).toISOString() : null,
      elementId: m.linkedElementId || null,
    })),
    stages,
  };
}

// ── «Где используется» ──────────────────────────────────────────────────────

export type UsageKind = 'tag' | 'element' | 'doc' | 'file' | 'vdr';

export interface UsageLink {
  kind: UsageKind | 'note' | 'chat' | 'system' | 'mail';
  id: string;
  title: string;
  subtitle: string;
  /** Куда ведёт нажатие; пусто — записи без своего экрана */
  route: string;
  /** Пометка вроде «упомянут 12 раз» */
  badge?: string;
}

export interface UsageGroup {
  id: string;
  title: string;
  /** Одна фраза о том, что означает эта связь — чтобы список не гадали */
  hint: string;
  links: UsageLink[];
}

export interface UsageResult {
  found: boolean;
  kind: UsageKind;
  id: string;
  title: string;
  subtitle: string;
  total: number;
  groups: UsageGroup[];
}

const nonEmpty = (groups: UsageGroup[]) => groups.filter(g => g.links.length > 0);

/**
 * Ссылка на файл несёт и папку: Проводник не хранит все файлы разом и по
 * одному идентификатору не знал бы, куда переходить.
 */
/** Ссылка на письмо: почта открывает ящик, папку и цепочку по этим трём */
const mailRoute = (m: MailLite) =>
  `/mail?account=${encodeURIComponent(m.accountId)}&folder=${encodeURIComponent(m.folderId)}&thread=${encodeURIComponent(m.threadKey)}`;

const fileRoute = (f: FileLite) =>
  `/explorer?file=${encodeURIComponent(f.id)}${f.folderId ? `&folder=${encodeURIComponent(f.folderId)}` : ''}`;

/**
 * Все места, где встречается объект.
 *
 * Ищем двумя способами сразу: по настоящим связям в базе (тег ↔ элемент, тег ↔
 * файл) и по упоминанию обозначения в тексте (документы, заметки, чат, ВДР).
 * Одного первого мало: формула =ТЕГ("AHU-2") в документе — это тоже связь, и
 * именно она ломается при переименовании.
 */
export function whereUsed(snap: ProjectSnapshot, kind: UsageKind, id: string): UsageResult {
  const empty: UsageResult = { found: false, kind, id, title: '', subtitle: '', total: 0, groups: [] };

  if (kind === 'tag') {
    const tag = snap.tags.find(t => t.id === id || t.identifier === id);
    if (!tag) return empty;
    const code = tag.identifier;
    const els = snap.elements.filter(e => e.tagIds.includes(tag.id) || e.tagCodes.includes(code));
    const systems = new Map<string, string>();
    for (const e of els) systems.set(e.systemId, e.systemName);

    const groups: UsageGroup[] = [
      {
        id: 'elements', title: 'Оборудование', hint: 'Элементы, на которых стоит этот тег',
        links: els.map(e => ({
          kind: 'element', id: e.id, title: e.itemCode,
          subtitle: `${e.systemName} · ${e.monoblockName} · ${e.equipType.toLowerCase()}`,
          route: `/equipment?element=${encodeURIComponent(e.id)}`,
          badge: e.hasConflict ? 'конфликт' : undefined,
        })),
      },
      {
        id: 'systems', title: 'Установки', hint: 'Куда этот тег входит целиком',
        links: [...systems].map(([sid, name]) => ({
          kind: 'system', id: sid, title: name, subtitle: 'установка', route: `/equipment?system=${encodeURIComponent(sid)}`,
        })),
      },
      {
        id: 'files', title: 'Файлы Проводника', hint: 'Файлы, помеченные этим тегом',
        links: snap.files.filter(f => f.tagIds.includes(tag.id)).map(f => ({
          kind: 'file', id: f.id, title: f.name, subtitle: f.folderName || 'корень раздела',
          route: fileRoute(f),
        })),
      },
      {
        id: 'docs', title: 'Документы Flux Office', hint: 'Обозначение встречается в тексте или в формуле',
        links: snap.docs.map(d => ({ d, n: countMentions(d.text, code) })).filter(x => x.n > 0).map(({ d, n }) => ({
          kind: 'doc' as const, id: d.id, title: d.name, subtitle: d.kind === 'TEXT' ? 'документ' : 'таблица',
          route: `/constructor?doc=${encodeURIComponent(d.id)}`, badge: `${n}×`,
        })),
      },
      {
        id: 'vdr', title: 'Реестр ВДР', hint: 'Строки, выпускаемые на это оборудование',
        links: snap.vdr.filter(v => v.tagCodes.some(c => c === code) || mentions(v.titleRu, code)).map(v => ({
          kind: 'vdr' as const, id: v.id, title: `${v.contractorNo || v.vdrCode || '—'} · ${v.titleRu}`,
          subtitle: `${v.registerName} · рев. ${v.revision}`,
          route: `/management?vdr=${encodeURIComponent(v.registerId)}&item=${encodeURIComponent(v.id)}`,
        })),
      },
      {
        id: 'mail', title: 'Почта', hint: 'Письма, где встречается обозначение',
        links: snap.mail.filter(m => mentions(m.text, code)).slice(0, 25).map(m => ({
          kind: 'mail' as const, id: m.id, title: m.subject || '(без темы)',
          subtitle: `${m.from}${m.sentAt ? ' · ' + new Date(m.sentAt).toLocaleDateString('ru-RU') : ''}`,
          route: mailRoute(m),
        })),
      },
      {
        id: 'notes', title: 'Заметки', hint: 'Ваши записи, где встречается обозначение',
        links: snap.notes.filter(n => mentions(n.title, code) || mentions(n.text, code)).map(n => ({
          kind: 'note' as const, id: n.id, title: n.title || 'Без названия', subtitle: 'заметка',
          route: `/notes?note=${encodeURIComponent(n.id)}`,
        })),
      },
      {
        id: 'chat', title: 'Обсуждения', hint: 'Сообщения, где обозначение упоминали',
        links: snap.chat.filter(m => mentions(m.text, code)).slice(0, 25).map(m => ({
          kind: 'chat' as const, id: m.id, title: m.text.slice(0, 90),
          subtitle: `${m.author}${m.at ? ' · ' + new Date(m.at).toLocaleDateString('ru-RU') : ''}`,
          route: '/chat',
        })),
      },
    ];
    const out = nonEmpty(groups);
    return {
      found: true, kind, id: tag.id, title: code,
      subtitle: [tag.mainName, tag.brand, tag.department].filter(Boolean).join(' · ') || 'тег проекта',
      total: out.reduce((s, g) => s + g.links.length, 0), groups: out,
    };
  }

  if (kind === 'element') {
    const el = snap.elements.find(e => e.id === id || e.itemCode === id);
    if (!el) return empty;
    const code = el.itemCode;
    const groups: UsageGroup[] = [
      {
        id: 'tags', title: 'Теги', hint: 'Обозначения, закреплённые за элементом',
        links: el.tagIds.map((tid, i) => {
          const t = snap.tags.find(x => x.id === tid);
          return {
            kind: 'tag' as const, id: tid, title: t?.identifier || el.tagCodes[i] || '—',
            subtitle: t ? `${t.stageLabel}${t.brand ? ' · ' + t.brand : ''}` : 'тег',
            route: `/registry?focus=${encodeURIComponent(tid)}`,
          };
        }),
      },
      {
        id: 'docs', title: 'Документы Flux Office', hint: 'Код элемента встречается в тексте или в формуле',
        links: snap.docs.map(d => ({ d, n: countMentions(d.text, code) })).filter(x => x.n > 0).map(({ d, n }) => ({
          kind: 'doc' as const, id: d.id, title: d.name, subtitle: d.kind === 'TEXT' ? 'документ' : 'таблица',
          route: `/constructor?doc=${encodeURIComponent(d.id)}`, badge: `${n}×`,
        })),
      },
      {
        id: 'chat', title: 'Обсуждения', hint: 'Сообщения об этом элементе',
        links: snap.chat.filter(m => m.elementId === el.id || mentions(m.text, code)).slice(0, 25).map(m => ({
          kind: 'chat' as const, id: m.id, title: m.text.slice(0, 90),
          subtitle: `${m.author}${m.at ? ' · ' + new Date(m.at).toLocaleDateString('ru-RU') : ''}`, route: '/chat',
        })),
      },
      {
        id: 'mail', title: 'Почта', hint: 'Письма, где встречается обозначение',
        links: snap.mail.filter(m => mentions(m.text, code)).slice(0, 25).map(m => ({
          kind: 'mail' as const, id: m.id, title: m.subject || '(без темы)',
          subtitle: `${m.from}${m.sentAt ? ' · ' + new Date(m.sentAt).toLocaleDateString('ru-RU') : ''}`,
          route: mailRoute(m),
        })),
      },
      {
        id: 'notes', title: 'Заметки', hint: 'Записи, где встречается код элемента',
        links: snap.notes.filter(n => mentions(n.title, code) || mentions(n.text, code)).map(n => ({
          kind: 'note' as const, id: n.id, title: n.title || 'Без названия', subtitle: 'заметка',
          route: `/notes?note=${encodeURIComponent(n.id)}`,
        })),
      },
    ];
    const out = nonEmpty(groups);
    return {
      found: true, kind, id: el.id, title: el.itemCode,
      subtitle: `${el.systemName} · ${el.monoblockName} · ${el.equipType.toLowerCase()}`,
      total: out.reduce((s, g) => s + g.links.length, 0), groups: out,
    };
  }

  if (kind === 'doc') {
    const doc = snap.docs.find(d => d.id === id);
    if (!doc) return empty;
    const usedTags = snap.tags.filter(t => t.identifier && mentions(doc.text, t.identifier));
    const usedEls = snap.elements.filter(e => e.itemCode && mentions(doc.text, e.itemCode));
    const groups: UsageGroup[] = [
      {
        id: 'tags', title: 'Теги в документе', hint: 'Изменение этих тегов меняет документ',
        links: usedTags.map(t => ({
          kind: 'tag' as const, id: t.id, title: t.identifier, subtitle: t.mainName || t.brand || 'тег',
          route: `/registry?focus=${encodeURIComponent(t.id)}`,
        })),
      },
      {
        id: 'elements', title: 'Элементы в документе', hint: 'Оборудование, на которое ссылается документ',
        links: usedEls.map(e => ({
          kind: 'element' as const, id: e.id, title: e.itemCode,
          subtitle: `${e.systemName} · ${e.monoblockName}`, route: `/equipment?element=${encodeURIComponent(e.id)}`,
        })),
      },
      {
        id: 'vdr', title: 'Строки ВДР', hint: 'Реестр, где этот документ значится выпуском',
        links: snap.vdr.filter(v => v.docId === doc.id).map(v => ({
          kind: 'vdr' as const, id: v.id, title: `${v.contractorNo || v.vdrCode || '—'} · ${v.titleRu}`,
          subtitle: `${v.registerName} · рев. ${v.revision}`,
          route: `/management?vdr=${encodeURIComponent(v.registerId)}&item=${encodeURIComponent(v.id)}`,
        })),
      },
      {
        id: 'files', title: 'Проводник', hint: 'Зеркало документа в папках проекта',
        links: snap.files.filter(f => f.refId === doc.id).map(f => ({
          kind: 'file' as const, id: f.id, title: f.name, subtitle: f.folderName || 'корень раздела',
          route: fileRoute(f),
        })),
      },
    ];
    const out = nonEmpty(groups);
    return {
      found: true, kind, id: doc.id, title: doc.name,
      subtitle: doc.kind === 'TEXT' ? 'документ Flux Office' : 'таблица Flux Office',
      total: out.reduce((s, g) => s + g.links.length, 0), groups: out,
    };
  }

  if (kind === 'file') {
    const file = snap.files.find(f => f.id === id);
    if (!file) return empty;
    const groups: UsageGroup[] = [
      {
        id: 'tags', title: 'Теги файла', hint: 'Обозначения, которыми помечен файл',
        links: file.tagIds.map(tid => {
          const t = snap.tags.find(x => x.id === tid);
          return {
            kind: 'tag' as const, id: tid, title: t?.identifier || '—', subtitle: t?.mainName || 'тег',
            route: `/registry?focus=${encodeURIComponent(tid)}`,
          };
        }),
      },
      {
        id: 'docs', title: 'Документ Flux Office', hint: 'Файл — зеркало этого документа',
        links: file.refId ? snap.docs.filter(d => d.id === file.refId).map(d => ({
          kind: 'doc' as const, id: d.id, title: d.name, subtitle: d.kind === 'TEXT' ? 'документ' : 'таблица',
          route: `/constructor?doc=${encodeURIComponent(d.id)}`,
        })) : [],
      },
      {
        id: 'vdr', title: 'Реестр ВДР', hint: 'Строки, где этот файл — замечания заказчика',
        links: snap.vdr.filter(v => mentions(v.titleRu, file.name)).map(v => ({
          kind: 'vdr' as const, id: v.id, title: `${v.contractorNo || v.vdrCode || '—'} · ${v.titleRu}`,
          subtitle: v.registerName,
          route: `/management?vdr=${encodeURIComponent(v.registerId)}&item=${encodeURIComponent(v.id)}`,
        })),
      },
    ];
    const out = nonEmpty(groups);
    return {
      found: true, kind, id: file.id, title: file.name,
      subtitle: `${file.folderName || 'корень раздела'}${file.revision ? ' · рев. ' + file.revision : ''}`,
      total: out.reduce((s, g) => s + g.links.length, 0), groups: out,
    };
  }

  // ВДР
  const item = snap.vdr.find(v => v.id === id);
  if (!item) return empty;
  const groups: UsageGroup[] = [
    {
      id: 'tags', title: 'Оборудование строки', hint: 'На что выпускается документ',
      links: item.tagCodes.map(code => {
        const t = snap.tags.find(x => x.identifier === code);
        return {
          kind: 'tag' as const, id: t?.id || code, title: code, subtitle: t?.mainName || 'тег',
          route: t ? `/registry?focus=${encodeURIComponent(t.id)}` : '',
        };
      }),
    },
    {
      id: 'docs', title: 'Документ выпуска', hint: 'Чем закрыта строка реестра',
      links: item.docId ? snap.docs.filter(d => d.id === item.docId).map(d => ({
        kind: 'doc' as const, id: d.id, title: d.name, subtitle: d.kind === 'TEXT' ? 'документ' : 'таблица',
        route: `/constructor?doc=${encodeURIComponent(d.id)}`,
      })) : [],
    },
  ];
  const out = nonEmpty(groups);
  return {
    found: true, kind, id: item.id, title: `${item.contractorNo || item.vdrCode || '—'} · ${item.titleRu}`,
    subtitle: `${item.registerName} · рев. ${item.revision}`,
    total: out.reduce((s, g) => s + g.links.length, 0), groups: out,
  };
}

// ── Общий поиск (Ctrl+K) ────────────────────────────────────────────────────

export interface SearchHit {
  kind: UsageKind | 'note' | 'section' | 'project' | 'mail';
  id: string;
  title: string;
  subtitle: string;
  route: string;
  score: number;
}

/** Насколько строка отвечает запросу: начало важнее середины, точное — важнее всего */
function scoreOf(text: string, q: string): number {
  const t = String(text || '').toLowerCase();
  if (!t) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 70;
  const at = t.indexOf(q);
  if (at < 0) return 0;
  // Совпадение после разделителя ценнее, чем внутри слова
  return /[\s._\-/]/.test(t[at - 1] || ' ') ? 45 : 25;
}

export function searchAll(snap: ProjectSnapshot, query: string, limit = 30): SearchHit[] {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return [];
  const hits: SearchHit[] = [];
  const push = (h: SearchHit) => { if (h.score > 0) hits.push(h); };

  for (const t of snap.tags) {
    push({
      kind: 'tag', id: t.id, title: t.identifier,
      subtitle: [t.mainName, t.brand, t.stageLabel].filter(Boolean).join(' · ') || 'тег',
      route: `/registry?focus=${encodeURIComponent(t.id)}`,
      score: Math.max(scoreOf(t.identifier, q), scoreOf(t.mainName, q) - 10, scoreOf(t.brand, q) - 15),
    });
  }
  for (const e of snap.elements) {
    push({
      kind: 'element', id: e.id, title: e.itemCode,
      subtitle: `${e.systemName} · ${e.monoblockName} · ${e.equipType.toLowerCase()}`,
      route: `/equipment?element=${encodeURIComponent(e.id)}`,
      score: Math.max(scoreOf(e.itemCode, q), scoreOf(e.name, q) - 5, scoreOf(e.systemName, q) - 20),
    });
  }
  for (const d of snap.docs) {
    push({
      kind: 'doc', id: d.id, title: d.name, subtitle: d.kind === 'TEXT' ? 'документ' : 'таблица',
      route: `/constructor?doc=${encodeURIComponent(d.id)}`, score: scoreOf(d.name, q),
    });
  }
  for (const f of snap.files) {
    push({
      kind: 'file', id: f.id, title: f.name, subtitle: f.folderName || 'корень раздела',
      route: fileRoute(f), score: scoreOf(f.name, q),
    });
  }
  for (const v of snap.vdr) {
    push({
      kind: 'vdr', id: v.id, title: `${v.contractorNo || v.vdrCode || '—'} · ${v.titleRu}`,
      subtitle: `${v.registerName} · рев. ${v.revision}`,
      route: `/management?vdr=${encodeURIComponent(v.registerId)}&item=${encodeURIComponent(v.id)}`,
      score: Math.max(scoreOf(v.contractorNo, q), scoreOf(v.titleRu, q) - 5, scoreOf(v.vdrCode, q) - 10),
    });
  }
  for (const n of snap.notes) {
    push({
      kind: 'note', id: n.id, title: n.title || 'Без названия', subtitle: 'заметка',
      route: `/notes?note=${encodeURIComponent(n.id)}`,
      score: Math.max(scoreOf(n.title, q), n.text.toLowerCase().includes(q) ? 20 : 0),
    });
  }
  for (const m of snap.mail) {
    push({
      kind: 'mail', id: m.id, title: m.subject || '(без темы)',
      subtitle: `письмо · ${m.from}`, route: mailRoute(m),
      score: Math.max(scoreOf(m.subject, q), scoreOf(m.from, q) - 15),
    });
  }
  for (const p of snap.projects) {
    push({
      kind: 'project', id: p.id, title: p.name,
      subtitle: p.id === snap.projectId ? 'текущий проект' : 'проект',
      route: '/projects', score: scoreOf(p.name, q),
    });
  }

  return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'ru')).slice(0, limit);
}
