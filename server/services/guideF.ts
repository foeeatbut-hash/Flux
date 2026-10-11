/**
 * Серверный движок ответов Flux Guide для кнопки F (ТЗ Messenger §9.5, §26;
 * Next_Steps §1).
 *
 * Правила безопасности:
 *  - личность автора и членство в разговоре проверяются на сервере;
 *  - ответ публикуется от сервисного отправителя «Flux Guide», а не от имени
 *    сотрудника;
 *  - проектный вопрос разрешён только если КАЖДЫЙ получатель разговора имеет
 *    доступ к проекту (серверно, canSeeProject). Иначе — общий отказ без
 *    содержимого: ни чисел, ни имён, ни preview;
 *  - повторный вызов с тем же requestMessageId не создаёт второй ответ;
 *  - прямые вызовы API с поддельным senderId отклоняются (личность из сессии).
 */
import { getPrisma } from '../context.js';
import { canSeeProject } from '../routes/members.js';
import { isAdminActor, isRealProjectId } from '../projectAccess.js';
import { isPrivilegedUser } from '../accessPolicy.js';
import { parseQuestion } from '../../src/guide/questionParser.js';
import { answerFromHandbook } from '../../src/assistant/handbookAnswers.js';
import { findKnowledge } from '../../src/assistant/knowledge.js';
import {
  flattenSpecs, findSpecExact, findSpecFuzzy, enrichTags, procurementStages, flatComponents,
} from '../routes/guide.js';

export const SERVICE_USER_ID = 'flux-guide-service';
const FOLD = (s: string): string => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const nowAt = (): string => new Date().toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Сервисный отправитель: нельзя войти (случайный пароль), виден только в чате. */
export async function ensureServiceUser(): Promise<{ id: string }> {
  const prisma = getPrisma();
  const user = await prisma.user.upsert({
    where: { id: SERVICE_USER_ID },
    update: {},
    create: {
      id: SERVICE_USER_ID,
      symbol: 'flux.guide',
      name: 'Flux Guide',
      lastName: 'Flux Guide',
      password: 'service:' + require('crypto').randomBytes(24).toString('hex'),
      role: 'SERVICE',
      isActive: true,
      position: 'Сервисная программа',
      department: 'Flux',
    },
  });
  return { id: user.id };
}

const toNumber = (v: string): number | null => {
  const cleaned = String(v).replace(',', '.').replace(/\s/g, '').replace(/[^\d.\-+eE]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

interface AudienceCheck { ok: boolean; memberIds: string[] }

/** Все получатели разговора и их доступ к проекту — проверяет сервер. */
async function audienceOf(prisma: any, type: 'DIRECT' | 'GROUP', conversationId: string): Promise<AudienceCheck> {
  if (type === 'GROUP') {
    const group = await prisma.chatGroup.findUnique({ where: { id: conversationId }, include: { members: { select: { id: true } } } });
    if (!group) return { ok: false, memberIds: [] };
    return { ok: true, memberIds: group.members.map((m: any) => m.id) };
  }
  const msg = await prisma.chatMessage.findFirst({ where: { id: conversationId }, select: { id: true } }).catch(() => null);
  void msg;
  return { ok: true, memberIds: [] };
}

/** Приватный диалог: участники по факту переписки. */
async function directParticipants(prisma: any, receiverId: string): Promise<string[]> {
  return [receiverId];
}

async function canAllSee(memberIds: string[], projectId: string): Promise<boolean> {
  for (const id of memberIds) {
    const user = await getPrisma().user.findUnique({ where: { id }, select: { role: true, isActive: true } });
    if (!user || user.isActive === false) return false;
    if (!(await canSeeProject(id, projectId, isAdminActor(user)))) return false;
  }
  return memberIds.length > 0;
}

// ── Проектные ответы серверного движка (безопасное подмножество) ──

interface FAnswer { text: string; status: 'ok' | 'no-match' }

async function answerProjectIntent(intent: string, question: string, projectId: string): Promise<FAnswer> {
  const prisma = getPrisma();
  const p = parseQuestion(question);
  const at = nowAt();

  if (intent === 'tag_lookup' && p.codes.length) {
    const code = p.codes[0];
    const rows = await prisma.tag.findMany({
      where: { projectId },
      include: { componentElements: { include: { monoblock: { include: { system: true } } } } },
    });
    const match = (rows as any[]).find((t) => String(t.identifier).trim() === code);
    if (!match) return { status: 'no-match', text: `Тега «${code}» в проекте нет. Проверьте раскладку (латинская B и кириллическая В выглядят одинаково), лишние пробелы и выбранный проект.` };
    const place = (match.componentElements || [])[0];
    const specs = place ? flattenSpecs(place.specs).list.slice(0, 6) : [];
    const lines = [
      `Тег «${code}» найден.`,
      place ? `Позиция: ${place.name} (${place.monoblock?.system?.name || '—'} → ${place.monoblock?.name || '—'}).` : 'Тег не привязан к оборудованию.',
      match.brand ? `Марка: ${match.brand}.` : '',
      ...specs.map((s) => `${s.key}: ${s.value}${s.unit ? ' ' + s.unit : ''}`),
      `Источник: Теги проекта · ${at}`,
    ].filter(Boolean);
    return { status: 'ok', text: lines.join('\n') };
  }

  if (intent === 'tag_duplicates') {
    const rows = await prisma.tag.findMany({ where: { projectId }, select: { id: true, identifier: true } });
    const byCode = new Map<string, number>();
    for (const t of rows as any[]) byCode.set(String(t.identifier).trim(), (byCode.get(String(t.identifier).trim()) || 0) + 1);
    const dups = [...byCode.entries()].filter(([, n]) => n > 1);
    if (!dups.length) return { status: 'ok', text: `Дубликатов кодов тегов в проекте нет (проверка по точному совпадению кода, ${at}).` };
    return { status: 'ok', text: `Найдено дубликатов кодов: ${dups.length}.\n${dups.slice(0, 5).map(([c, n]) => `· ${c} — ${n} шт.`).join('\n')}\nИсточник: Теги проекта · ${at}` };
  }

  if (intent === 'equipment_no_tag' || intent === 'equipment_list' || intent === 'project_count') {
    const components = await flatComponents(projectId);
    const type = p.equipmentTypes[0]?.canonical;
    let list = components;
    if (type) list = list.filter((c) => c.equipType === type);
    if (intent === 'equipment_no_tag' || p.normalized.includes('без тег')) list = list.filter((c) => !c.tags.length);
    const total = list.length;
    if (intent === 'project_count') {
      if (type) return { status: 'ok', text: `${type}: ${total} поз. (счёт по классу оборудования, не по подстроке имени. Источник: Оборудование проекта · ${at})` };
      const summary = { tags: await prisma.tag.count({ where: { projectId } }), components: components.length };
      return { status: 'ok', text: `Тегов в проекте: ${summary.tags}, позиций оборудования: ${summary.components}. Источник: Теги/Оборудование проекта · ${at}` };
    }
    if (!total) return { status: 'no-match', text: intent === 'equipment_no_tag' ? `Позиций без тега${type ? ` среди «${type}»` : ''} нет — у всего оборудования есть привязка.` : 'По выбранным условиям ничего не найдено.' };
    return {
      status: 'ok',
      text: `${intent === 'equipment_no_tag' ? 'Без тега' : `«${type || 'Оборудование'}»`}: ${total} поз.\n${list.slice(0, 5).map((c) => `· ${c.name} (${c.systemName}${c.tags.length ? ', тег ' + c.tags[0].identifier : ' без тега'})`).join('\n')}${total > 5 ? `\n… всего ${total} — полный список в разделе «Оборудование».` : ''}\nИсточник: Оборудование проекта · ${at}`,
    };
  }

  if (intent === 'equipment_characteristic' || intent === 'equipment_missing_field') {
    const field = p.fields[0];
    if (!field) return { status: 'no-match', text: 'Уточните, какая характеристика нужна (расход, давление, питание…).' };
    const components = await flatComponents(projectId);
    if (p.codes.length) {
      const comp = components.find((c) => c.tags.some((t) => t.identifier === p.codes[0]));
      if (!comp) return { status: 'no-match', text: `Тега «${p.codes[0]}» в проекте нет или он не привязан к позиции.` };
      const found = findSpecExact(comp.specs, FOLD(field.keys[0])) || findSpecFuzzy(comp.specs, FOLD(field.keys[0]));
      if (!found) return { status: 'no-match', text: `У позиции ${comp.name} характеристика «${field.canonical}» не заполнена.` };
      return { status: 'ok', text: `Позиция ${comp.name} (${comp.systemName}): ${found.key} = ${found.value}${found.unit ? ' ' + found.unit : ''}. Источник: Оборудование проекта · ${at}` };
    }
    if (intent === 'equipment_missing_field') {
      const list = components.filter((c) => !(findSpecExact(c.specs, FOLD(field.keys[0])) || findSpecFuzzy(c.specs, FOLD(field.keys[0]))));
      if (!list.length) return { status: 'no-match', text: `Позиций с незаполненным полем «${field.canonical}» нет.` };
      return { status: 'ok', text: `«${field.canonical}» не указано у ${list.length} поз.\n${list.slice(0, 5).map((c) => `· ${c.name} (${c.systemName})`).join('\n')}\nИсточник: Оборудование проекта · ${at}` };
    }
    const rows = components
      .map((c) => ({ c, found: findSpecExact(c.specs, FOLD(field.keys[0])) || findSpecFuzzy(c.specs, FOLD(field.keys[0])) }))
      .filter((r) => r.found);
    if (!rows.length) return { status: 'no-match', text: `Характеристика «${field.canonical}» в проекте не заполнена ни у одной позиции.` };
    return { status: 'ok', text: `«${field.canonical}» заполнено у ${rows.length} поз.\n${rows.slice(0, 5).map((r) => `· ${r.c.name}: ${r.found!.value}${r.found!.unit ? ' ' + r.found!.unit : ''} (${r.c.systemName})`).join('\n')}\nИсточник: Оборудование проекта · ${at}` };
  }

  if (intent === 'project_summary') {
    const components = await flatComponents(projectId);
    const tags = await prisma.tag.count({ where: { projectId } });
    const systems = await prisma.equipmentSystem.count({ where: { projectId } });
    return { status: 'ok', text: `Проект: тегов ${tags}, систем ${systems}, позиций оборудования ${components.length}. Источник: Сводка проекта · ${at}` };
  }

  if (intent === 'procurement_state') {
    const stages = await procurementStages();
    const rows = await prisma.tag.findMany({ where: { projectId }, select: { identifier: true, metadata: true } });
    const byStage = new Map<string, number>(stages.map((s) => [s.id, 0]));
    for (const t of rows as any[]) {
      let stage = 'added';
      try { stage = JSON.parse(t.metadata || '{}')?.procurement?.stage || 'added'; } catch {}
      if (byStage.has(stage)) byStage.set(stage, (byStage.get(stage) || 0) + 1);
    }
    return { status: 'ok', text: `Этапы закупки по проекту:\n${stages.map((s) => `· ${s.label}: ${byStage.get(s.id) || 0}`).join('\n')}\nИсточник: Закупки проекта · ${at}` };
  }

  if (intent === 'equipment_revision') {
    const components = await flatComponents(projectId);
    const targets = p.codes[0]
      ? components.filter((c) => c.tags.some((t) => t.identifier === p.codes[0]))
      : components.filter((c) => c.hasConflict);
    if (!targets.length) return { status: 'no-match', text: 'Изменений характеристик и конфликтов ревизий по этому запросу в журнале нет.' };
    const ids = targets.slice(0, 5).map((c) => c.id);
    const history = await prisma.equipmentHistory.findMany({ where: { elementId: { in: ids } }, orderBy: { changedAt: 'desc' }, take: 10 });
    if (!history.length) return { status: 'no-match', text: 'Ревизий в журнале для этих позиций нет.' };
    const lines = history.slice(0, 3).map((h: any) => {
      const c = targets.find((x) => x.id === h.elementId);
      return `· ${c?.name || 'позиция'} (v${h.version}): ${diffText(h.oldSpecs, h.newSpecs)}`;
    });
    return { status: 'ok', text: `Последние изменения характеристик:\n${lines.join('\n')}\nПринять или отклонить ревизию может только человек. Источник: Журнал оборудования · ${at}` };
  }

  if (intent === 'document_search') {
    if (!p.codes.length) return { status: 'no-match', text: 'Уточните код тега: файлы ищутся по точному коду (например, «есть ли файлы у тега 3700-B08-DW-002B?»).' };
    const tags = await prisma.tag.findMany({ where: { projectId, identifier: p.codes[0] }, select: { id: true } });
    const ids = tags.map((t: any) => t.id);
    if (!ids.length) return { status: 'no-match', text: `Тега «${p.codes[0]}» в проекте нет — файлов не искать по чему.` };
    const files = await prisma.fileNode.findMany({
      where: { deletedAt: null, folder: { projectId, deletedAt: null }, OR: [{ mainTags: { some: { id: { in: ids } } } }, { additionalTags: { some: { id: { in: ids } } } }] },
      select: { name: true, revision: true }, take: 5,
    });
    if (!files.length) return { status: 'no-match', text: `Файлов по тегу «${p.codes[0]}» в проекте нет.` };
    return { status: 'ok', text: `Файлов по тегу «${p.codes[0]}»: ${files.length}.\n${files.map((f: any) => `· ${f.name} (ред. ${f.revision})`).join('\n')}\nИсточник: Проводник проекта · ${at}` };
  }

  return { status: 'no-match', text: 'Такой проектный запрос Guide в разговоре пока не обрабатывает.' };
}

function diffText(oldRaw: string | null, newRaw: string | null): string {
  try {
    const oldList: any[] = flattenSpecs(oldRaw).list;
    const newList: any[] = flattenSpecs(newRaw).list;
    const keyOf = (x: any) => FOLD(x.group) + '|' + FOLD(x.key);
    const oldMap = new Map(oldList.map((x) => [keyOf(x), x]));
    const out: string[] = [];
    for (const [k, p] of new Map(newList.map((x) => [keyOf(x), x]))) {
      const before = oldMap.get(k);
      if (!before) out.push(`${p.key}: — → ${p.value}`);
      else if (before.value !== p.value) out.push(`${p.key}: ${before.value} → ${p.value}`);
    }
    return out.slice(0, 3).join('; ') || 'без изменений значений';
  } catch { return 'без изменений значений'; }
}

const REFUSAL = 'Не могу опубликовать эти сведения в этом разговоре: не у всех участников есть доступ к проекту. Откройте Flux Guide — там ответ можно получить лично.';
const NEED_PROJECT = 'Для проектного вопроса нужен проект, доступный всем участникам разговора. Выберите его в Flux Guide или задайте общий вопрос по программам Flux.';

export interface FRequest {
  type: 'DIRECT' | 'GROUP';
  conversationId: string;
  requestMessageId: string;
  question: string;
  actorId: string;
  /** Проект, названный клиентом; сервер проверяет его для всех участников */
  projectId?: string;
}

export interface FPublishResult { published: boolean; refusal: boolean; text: string; projectId?: string }

/** Полный цикл F-запроса на сервере: аудитория → ответ/отказ → публикация. */
export async function handleFRequest(req: FRequest): Promise<FPublishResult> {
  const prisma = getPrisma();
  const service = await ensureServiceUser();

  // 1. Запрос существует, в этом разговоре, автор — тот, кто вызывает
  const request = await prisma.chatMessage.findUnique({
    where: { id: req.requestMessageId },
    include: { chatGroup: { include: { members: { select: { id: true } } } } },
  });
  if (!request || request.senderId !== req.actorId || request.senderId === service.id) return { published: false, refusal: true, text: 'Запрос не найден.' };

  // 2. Члены разговора (сервер, не клиент)
  let memberIds: string[] = [];
  let boundProjectId: string | null = null;
  if (req.type === 'GROUP') {
    const group = request.chatGroup;
    if (!group || group.id !== req.conversationId || !(group.members || []).some((m: any) => m.id === req.actorId)) return { published: false, refusal: true, text: 'Запрос не найден.' };
    memberIds = group.members.map((m: any) => m.id);
    boundProjectId = group.projectId || null;
  } else {
    if (request.chatGroupId || request.receiverId !== req.conversationId) return { published: false, refusal: true, text: 'Запрос не найден.' };
    memberIds = [req.actorId, req.conversationId];
  }

  const persistedQuestion = String(request.content || '').trim();
  if (!persistedQuestion || persistedQuestion.length > 2000) return { published: false, refusal: true, text: 'Запрос не найден.' };

  // 3. Повтор с тем же запросом не создаёт второй ответ (идемпотентность ретрая)
  const existing = await prisma.chatMessage.findFirst({
    where: { guideReply: { requestMessageId: req.requestMessageId } },
    select: { id: true },
  });
  if (existing) return { published: false, refusal: false, text: 'Ответ уже опубликован.' };

  const p = parseQuestion(persistedQuestion);
  const projectIntents = new Set(['tag_lookup', 'tag_duplicates', 'equipment_no_tag', 'equipment_missing_field', 'equipment_characteristic', 'equipment_list', 'project_count', 'project_summary', 'procurement_state', 'equipment_revision', 'document_search']);

  let answerText: string;
  let refusal = false;
  let answerProjectId = '';

  // 4. Не-проектные вопросы: справка без данных проекта — открыта всем
  if (!projectIntents.has(p.intent) && !p.codes.length) {
    const g = findKnowledge(persistedQuestion);
    answerText = g || answerFromHandbook(persistedQuestion, 4, () => false)?.text
      || 'В проверенной справке нет точного ответа на этот вопрос. Уточните формулировку или откройте Flux Guide.';
  } else {
    // 5. Проектный вопрос: проект связан с разговором или назван клиентом,
    //    но сервер проверяет доступ КАЖДОГО получателя
    const projectId = boundProjectId && isRealProjectId(boundProjectId) ? boundProjectId : (isRealProjectId(req.projectId) ? String(req.projectId) : '');
    if (!projectId || !isRealProjectId(projectId)) {
      answerText = NEED_PROJECT;
      refusal = true;
    } else if (!(await canAllSee(memberIds, projectId))) {
      // 6. Хоть один получатель без доступа — общий отказ без содержимого:
      //    ни чисел, ни имён, ни preview (ТЗ Next_Steps §1)
      answerText = REFUSAL;
      refusal = true;
    } else {
      answerProjectId = projectId;
      const a = await answerProjectIntent(p.intent, persistedQuestion, projectId).catch(() => ({ status: 'no-match' as const, text: 'Не получилось проверить данные. Повторите запрос позже.' }));
      answerText = a.text;
    }
  }

  // 7. Публикация сервисного ответа в исходный разговор
  const reply = await prisma.chatMessage.create({
    data: {
      content: `F · Flux Guide\n\n${answerText}`,
      senderId: service.id,
      ...(req.type === 'GROUP' ? { chatGroupId: req.conversationId } : { receiverId: req.conversationId }),
      replyToId: req.requestMessageId,
      guideReply: { create: { requestMessageId: req.requestMessageId, projectId: refusal ? '' : answerProjectId, kind: p.intent } },
    },
  });
  void memberIds;
  return { published: true, refusal, text: answerText, projectId: refusal ? '' : answerProjectId, ...( { replyId: reply.id } as any) } as FPublishResult;
}

/** Комнаты для рассылки события чата участникам (та же конвенция, что в chat.ts). */
export function roomsFor(memberIds: string[]): string[] {
  return memberIds.map((id) => `user:${id}`);
}

/** Прямой доступ участникам приватного диалога. */
export { directParticipants, canAllSee };
