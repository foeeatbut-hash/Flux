/**
 * Движок ответов Flux Guide: намерение → проверенный ответ (ТЗ v3 §8, §9, §34, §36).
 *
 * Правила честности (ТЗ §1.2, §8.4, §11.4):
 *  - неизвестное не придумывается: «нет ответа» — это ответ, плюс предложения;
 *  - пустое значение, «нет доступа», «данные не загружены» и «не найдено» —
 *    четыре разных состояния, не склеиваются в одно «нет»;
 *  - ответ показывает источник: статья справочника или данные проекта;
 *  - продолжение вопроса («их», «а без тегов», «выгрузи») работает только по
 *    последнему НАСТОЯЩЕМУ результату того же проекта (ТЗ §36.4).
 *
 * Модуль без React: его использует экран Guide и вызов F в Мессенджере.
 */
import {
  guideSummary, guideTags, guideComponents, guideTagLookup, guideSpec, guideRevisions, guideFiles,
  type GuideTag, type GuideComponent, type GuideSpecRow,
} from './projects';
import { parseQuestion, FIELDS, EQUIPMENT_TYPES, type ParsedQuestion, type FieldType } from './questionParser';
import { answerFromHandbook } from '../assistant/handbookAnswers';
import { findBestTour } from '../assistant/tours';
import { findKnowledge } from '../assistant/knowledge';
import { allowEntitlement } from '../store/policyStore';
import { uid, type GuideMessage, type GuideAction, type GuideTable, type GuideCard } from './types';

export interface AskContext {
  userId: string;
  /** Явно выбранный проект; null — проект не выбран (и не угадывается) */
  projectId: string | null;
  projectName?: string;
  /** Продолжение разговора: структурированный фильтр последнего результата */
  lastResult?: LastResult | null;
}

/** Структурированный контекст последнего ответа — для «их», «а без тегов», «выгрузи». */
export interface LastResult {
  intent: string;
  label: string;
  projectId: string;
  equipmentType?: string;
  untagged?: boolean;
  missingField?: string;
  query?: string;
  systemName?: string;
  field?: string;
  code?: string;
  total?: number;
}

const nowAt = (): string => new Date().toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

const say = (text: string, extra: Partial<GuideMessage> = {}): GuideMessage => ({
  id: uid(), role: 'guide', status: 'ok', text, ...extra,
});

/** Проставляет продолжению контекст: только реальные результаты проекта. */
function withContext<M extends { context?: unknown }>(msg: M, ctx: AskContext, context: Omit<NonNullable<GuideMessage['context']>, 'projectId'>): M {
  return { ...msg, context: { ...context, projectId: ctx.projectId || '' } };
}

const sourceOf = (ctx: AskContext, label: string): GuideMessage['source'] => ({
  label: ctx.projectName ? `${label} · ${ctx.projectName}` : label,
  at: nowAt(),
});

const openTagAction = (t: { id: string; identifier: string }): GuideAction =>
  ({ kind: 'focus-tag', label: 'Открыть в Тегах', tagId: t.id, code: t.identifier });

const openComponentAction = (c: { id: string; name: string }): GuideAction =>
  ({ kind: 'focus-equipment', label: 'Открыть карточку', componentId: c.id });

const exportAction = (title: string): GuideAction =>
  ({ kind: 'open-export', label: 'Выгрузить в Excel', route: '/equipment-export', query: title });

// ── Классификация актуальности ──

const ACTUALITY_RU: Record<string, string> = {
  actual: 'актуален', warning: 'есть предупреждение', critical: 'критично устарел',
  info: 'есть заметка', draft: 'черновик — данные не подтверждены',
};

const STAGE_WORDS: Array<{ re: RegExp; stage: string }> = [
  { re: /заказан|заказа/, stage: 'ordered' },
  { re: /утвержд/, stage: 'approved' },
  { re: /куплен|закуплен/, stage: 'purchased' },
  { re: /добавлен|новый|заведен/, stage: 'added' },
];

// ── Глоссарий: термины инженера простыми словами (ТЗ §9 «glossary», §31.5) ──

const GLOSSARY: Array<{ keys: string[]; term: string; text: string }> = [
  { keys: ['тег'], term: 'Тег', text: 'Тег — буквенно-цифровое обозначение объекта на проекте, например 3700-B08-DW-002B. По нему позицию узнают чертежи, спецификации и закупки. Латинская B и кириллическая В выглядят одинаково, но это разные символы — код копируют без изменений.' },
  { keys: ['ревизия', 'версия'], term: 'Ревизия', text: 'Ревизия — зафиксированная версия характеристик позиции. При загрузке нового расчёта Flux сравнивает старые и новые значения и показывает «Было / Стало». Принять или отклонить ревизию может только человек.' },
  { keys: ['моноблок'], term: 'Моноблок', text: 'Моноблок — сборка внутри системы (например, приточная установка), состоящая из компонентов: вентилятора, клапана, фильтра. Структура проекта: проект → система → моноблок → компонент → характеристики.' },
  { keys: ['система'], term: 'Система', text: 'Система — раздел проекта (например, П1 — венткамера), объединяющий оборудование одного назначения. Категории: приточные установки, вентиляторы, клапаны, завесы.' },
  { keys: ['компонент', 'позиция'], term: 'Компонент', text: 'Компонент — отдельная позиция оборудования внутри моноблока: вентилятор, клапан, фильтр. У него свои характеристики и свои теги, отличные от главного тега установки.' },
  { keys: ['характеристика', 'параметр'], term: 'Характеристика', text: 'Характеристика — измеряемый параметр позиции (расход воздуха, давление, питание) с единицей измерения. Отсутствие значения показывается как «—», а не как ноль.' },
  { keys: ['актуальность'], term: 'Актуальность', text: 'Актуальность — статус достоверности данных тега: актуален, есть предупреждение, критично устарел, черновик. Определяется по описаниям тега, а не по дате правки.' },
  { keys: ['дубл'], term: 'Дубликат тега', text: 'Дубликат — точное совпадение кода у двух и более тегов одного проекта. Похожие коды (…002B и …0028) дублями не считаются: это разные позиции.' },
  { keys: ['выгрузк', 'экспорт'], term: 'Выгрузка', text: 'Выгрузка создаёт файл из данных Flux (Excel, Flux Office). Не путать с загрузкой: загрузка берёт файл в Flux. Строки и столбцы выбираются в разделе «Выгрузка данных».' },
  { keys: ['закупк', 'этап'], term: 'Этапы закупки', text: 'Этапы закупки настраивает администратор (например: Добавлен, Заказан, Утверждён, Куплен). Guide считает позиции только по этим формальным этапам, а не по словам в статусе.' },
  { keys: ['кнопк f', 'f в мессенджере', 'флюкс гайд в чате'], term: 'Кнопка F', text: 'Кнопка F в Мессенджере — рядом с отправкой. Включите её, и сообщение станет вопросом Flux Guide: ответ придёт в тот же разговор и будет виден всем его участникам. При смене разговора режим выключается.' },
  { keys: ['flux guide', 'флюкс гайд', 'помощник'], term: 'Flux Guide', text: 'Flux Guide — справочник, вопросы и пошаговое обучение в одной программе. Отвечает по проверенным статьям и данным выбранного проекта; не придумывает ответов. Открывается из Пуска, кнопкой F в Мессенджере или клавишей F1.' },
];

function glossaryAnswer(text: string): GuideMessage | null {
  const n = text.toLowerCase().replace(/ё/g, 'е');
  const entry = GLOSSARY.find((g) => g.keys.some((k) => n.includes(k)));
  if (!entry) return null;
  return say(entry.text, {
    outcome: entry.term,
    text: entry.text,
    source: { label: 'Справочник Flux Guide', at: nowAt() },
  });
}

// ── Диагностика типовых ошибок: 4 части (ТЗ v3 §34.1) ──

interface Diagnostic { keys: string[]; title: string; happened: string; means: string; check: string[]; action?: GuideAction }

const DIAGNOSTICS: Diagnostic[] = [
  {
    keys: ['импорт xml', 'xml не', 'не прошёл импорт', 'не загружается xml', 'xml не читается', 'файл не читается', 'неверный xml', 'ошибка импорта'],
    title: 'Импорт XML не прошёл',
    happened: 'Расчётный XML не загрузился или загрузился частично.',
    means: 'Чаще всего дело в самом файле или в правах, а не в программе: не тот формат, повреждённый файл или нет доступа на изменение оборудования.',
    check: [
      'Файл имеет расширение .xml и получен из той же расчётной программы, что и раньше.',
      'Файл открывается на компьютере и не пустой (размер больше нуля).',
      'Выбран нужный проект: импорт попадает в активный проект.',
      'У вас есть право изменять оборудование (см. статью «Права и роли»).',
    ],
    action: { kind: 'open-article', label: 'Статья: Загрузка оборудования из XML', route: '/guide?article=equipment' },
  },
  {
    keys: ['тег занят', 'занят', 'тег уже связан', 'тег используется'],
    title: 'Тег уже связан с другой позицией',
    happened: 'Программа не даёт привязать тег: он уже используется.',
    means: 'Один тег привязывается к одной основной позиции. Это защита от путаницы в закупках и чертежах.',
    check: [
      'Откройте тег в разделе «Теги» и посмотрите, к чему он привязан сейчас.',
      'Если привязка ошибочна — снимите её штатно, затем привяжите заново.',
      'Если теги похожи (латинская B и кириллическая В) — проверьте символы.',
    ],
    action: { kind: 'navigate', label: 'Открыть Теги', route: '/registry' },
  },
  {
    keys: ['конфликт ревиз', 'ревизия конфликт', 'было стало'],
    title: 'Конфликт ревизии',
    happened: 'Новая поставка отличается от сохранённых характеристик.',
    means: 'Flux показывает «Было / Стало» и ждёт решения человека. Автоматически ревизия не принимается.',
    check: [
      'Откройте карточку позиции со значком конфликта.',
      'Сравните параметры построчно: старое и новое значение с единицами.',
      'Если новое верно — примите ревизию штатной кнопкой; если нет — оставьте старое и сверьтесь с расчётом.',
    ],
    action: { kind: 'open-article', label: 'Статья: Оборудование', route: '/guide?article=equipment' },
  },
  {
    keys: ['нет доступа', 'не могу открыть проект', 'доступ запрещ'],
    title: 'Нет доступа',
    happened: 'Данные не открываются: доступ ограничен.',
    means: 'Права на проект или раздел выдаёт администратор. Guide не раскрывает даже существование закрытых объектов.',
    check: [
      'Выбран ли правильный проект (данные другого проекта не откроются).',
      'Запросите доступ у администратора — в статье «Права и роли» описан порядок.',
    ],
    action: { kind: 'open-article', label: 'Статья: Права и роли', route: '/guide?article=perms' },
  },
  {
    keys: ['сервер недоступен', 'нет связи', 'нет соединения', 'не отвечает сервер'],
    title: 'Сервер недоступен',
    happened: 'Свежие данные получить не удалось.',
    means: 'Возможна потеря связи с сервером или техническая пауза. Устаревший кэш не выдаётся за актуальные данные.',
    check: [
      'Проверьте подключение к сети.',
      'Повторите запрос через минуту: кнопка «Повторить» не теряет введённый текст.',
    ],
  },
];

function diagnosticAnswer(text: string): GuideMessage | null {
  const n = text.toLowerCase().replace(/ё/g, 'е');
  const d = DIAGNOSTICS.find((x) => x.keys.some((k) => n.includes(k)));
  if (!d) return null;
  return say(d.happened, {
    outcome: d.title,
    text: `Что произошло: ${d.happened}\nЧто это означает: ${d.means}\n\nЧто проверить:\n${d.check.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
    actions: d.action ? [d.action] : [],
    source: { label: 'Диагностика Flux Guide', at: nowAt() },
  });
}

// ── Ответы справочника (без проекта) ──

function handbookAnswer(question: string, ctx: AskContext): GuideMessage | null {
  const ans = answerFromHandbook(question, 4, allowEntitlement);
  if (!ans) return null;
  return say(ans.text, {
    actions: [
      { kind: 'open-article', label: `Статья «${ans.articleTitle}»`, articleId: ans.articleId, route: `/guide?article=${encodeURIComponent(ans.articleId)}&at=${encodeURIComponent(ans.anchor)}` },
    ],
    source: { label: 'Справочник Flux', at: nowAt(), articleId: ans.articleId, articleTitle: ans.articleTitle },
  });
}

function tourAnswer(question: string): GuideMessage | null {
  const match = findBestTour(question, allowEntitlement);
  if (!match || match.score < 2) return null;
  const t = match.tour;
  return say(`В Flux есть пошаговая демонстрация по этому делу.`, {
    outcome: `Демонстрация «${t.title}»`,
    text: `«${t.intro}»\n\nШагов: ${t.steps.length}. Запустите демонстрацию — Guide откроет нужный раздел и подсветит, что нажимать. Вы делаете действия сами.`,
    actions: [{ kind: 'tour', label: `Показать: ${t.title}`, tourId: t.id }],
    source: { label: 'Демонстрации Flux Guide', at: nowAt() },
  });
}

function knowledgeAnswer(question: string): GuideMessage | null {
  const text = findKnowledge(question);
  if (!text) return null;
  return say(text, { source: { label: 'Проверенная справка Flux', at: nowAt() } });
}

function openSectionAnswer(question: string): GuideMessage | null {
  const p = parseQuestion(question);
  const routeWords: Array<[RegExp, string, string]> = [
    [/тег|реестр/, '/registry', 'Теги'],
    [/оборудован|вентилятор|установк/, '/equipment', 'Оборудование'],
    [/выгрузк|экспорт|ведомост/, '/equipment-export', 'Выгрузка данных'],
    [/каталог/, '/catalog', 'Каталог'],
    [/e3|схем/, '/e3flux', 'E3Flux'],
    [/проводник|файл/, '/explorer', 'Проводник'],
    [/закуп|менеджмент/, '/management', 'Менеджмент'],
    [/проект/, '/projects', 'Проекты'],
    [/конструктор/, '/builder', 'Конструктор'],
    [/справочн|словар/, '/directory', 'Справочник'],
    [/настройк/, '/settings', 'Настройки'],
    [/мессендж|чат/, '/chat', 'Мессенджер'],
  ];
  for (const [re, route, title] of routeWords) {
    if (re.test(p.normalized)) {
      return say(`Открываю раздел «${title}».`, {
        actions: [{ kind: 'navigate', label: `Перейти в «${title}»`, route }],
        source: { label: 'Навигация Flux', at: nowAt() },
      });
    }
  }
  return null;
}

// ── Ответы по данным проекта ──

async function tagLookupAnswer(p: ParsedQuestion, ctx: AskContext): Promise<GuideMessage> {
  const code = p.codes[0];
  const found = await guideTagLookup(ctx.userId, ctx.projectId!, code);
  if (found.status === 'no-match') {
    const near = await guideTags(ctx.userId, ctx.projectId!, { q: code, limit: 5 }).catch(() => null);
    return say(`Тега «${code}» в проекте нет.`, {
      status: 'no-match',
      text: near && near.items.length
        ? `Тега «${code}» в проекте нет. Похожие коды есть, но это другие теги — подставлять их вместо введённого нельзя:`
        : `Тега «${code}» в проекте нет и похожих кодов тоже. Проверьте раскладку (латинская B и кириллическая В выглядят одинаково), лишние пробелы и выбранный проект.`,
      list: near && near.items.length ? {
        items: near.items.map((t) => ({
          id: t.id, title: t.identifier, subtitle: t.mainName || t.brand || '', badge: 'похожий код',
          action: openTagAction(t),
        })),
      } : undefined,
      source: sourceOf(ctx, 'Теги проекта'),
    });
  }
  const tag: GuideTag = found.tags![0];
  const places = found.places || [];
  const fields: GuideCard['fields'] = [
    { label: 'Код', value: tag.identifier },
    { label: 'Марка', value: tag.brand || '—' },
    { label: 'Отдел', value: tag.department || '—' },
    { label: 'Среда', value: tag.fluid || '—' },
    { label: 'Актуальность', value: ACTUALITY_RU[tag.actuality] || tag.actuality },
    { label: 'Этап закупки', value: `${tag.stageLabel}${tag.supplier ? ` · ${tag.supplier}` : ''}${tag.qty ? ` · ${tag.qty}` : ''}` },
    { label: 'Привязан к позициям', value: tag.components.length ? tag.components.map((c) => c.name).join(', ') : '— (тег без оборудования)' },
  ];
  const cards: GuideCard[] = [{
    kind: 'tag', id: tag.id, title: tag.identifier,
    subtitle: places[0] ? `${places[0].system} → ${places[0].monoblock} → ${places[0].component}` : 'Тег не привязан к оборудованию',
    badge: tag.stageLabel, fields,
    action: openTagAction(tag),
  }];
  const specTable = places[0]?.specs?.length ? {
    title: `Характеристики позиции ${places[0].component}`,
    columns: ['Группа', 'Параметр', 'Значение', 'Ед.'],
    rows: places[0].specs.slice(0, 40).map((s) => [s.group, s.key, s.value, s.unit]),
    total: places[0].specsTotal,
    note: places[0].specsTotal > 40 ? `Показаны первые 40 из ${places[0].specsTotal}` : undefined,
  } : undefined;
  return withContext(say(`Тег «${tag.identifier}» найден.`, {
    outcome: `Тег ${tag.identifier}${places[0] ? ` · ${places[0].system} → ${places[0].component}` : ''}`,
    cards,
    table: specTable,
    actions: [
      openTagAction(tag),
      ...(places[0] ? [openComponentAction({ id: places[0].componentId, name: places[0].component })] : []),
      { kind: 'ask', label: 'Есть файлы по этому тегу?', query: `есть ли файлы у тега ${tag.identifier}` },
    ],
    source: sourceOf(ctx, 'Теги проекта'),
  }), ctx, { intent: 'tag_lookup', label: `Тег ${tag.identifier}`, code: tag.identifier });
}

async function duplicatesAnswer(ctx: AskContext): Promise<GuideMessage> {
  const res = await guideTags(ctx.userId, ctx.projectId!, { dup: 1, limit: 200 });
  if (!res.items.length) {
    return say('Дубликатов кодов тегов в проекте нет.', {
      text: 'Проверка выполнена по точному совпадению нормализованного кода в выбранном проекте. Похожие коды дублями не считаются.',
      source: sourceOf(ctx, 'Теги проекта'),
    });
  }
  const byCode = new Map<string, GuideTag[]>();
  for (const t of res.items) (byCode.get(t.identifier) || byCode.set(t.identifier, []).get(t.identifier)!).push(t);
  return say(`Найдено дубликатов кодов: ${byCode.size}.`, {
    outcome: `Групп совпавших кодов в показанной выборке: ${byCode.size}`,
    text: 'Дубль — точное совпадение нормализованного кода (регистр и пробелы). Похожие коды дублями не считаются.',
    table: {
      title: 'Дубликаты тегов',
      columns: ['Код', 'Сколько', 'Марка', 'Этап'],
      rows: [...byCode.values()].map((ts) => [ts[0].identifier, String(ts.length), ts.map((t) => t.brand || '—').join(' / '), ts[0].stageLabel]),
      total: byCode.size,
      note: res.truncated ? `Показаны первые 200 тегов из ${res.total}; уточните запрос для просмотра остальных.` : undefined,
    },
    actions: [{ kind: 'navigate', label: 'Открыть Теги', route: '/registry' }],
    source: sourceOf(ctx, 'Теги проекта'),
  });
}

async function noTagAnswer(ctx: AskContext, type?: string): Promise<GuideMessage> {
  const params: Record<string, string | number> = { untagged: 1, limit: 200 };
  if (type) params.type = type;
  const res = await guideComponents(ctx.userId, ctx.projectId!, params);
  const total = res.total;
  const typeSuffix = type ? ` среди «${type}»` : '';
  if (!total) {
    return say(`Позиций без тега${typeSuffix} нет — у всего оборудования есть привязка.`, { source: sourceOf(ctx, 'Оборудование проекта') });
  }
  return withContext(say(`Без тега: ${total} поз.${typeSuffix}`, {
    outcome: `Позиций без тега: ${total}`,
    text: 'Это компоненты оборудования, к которым не привязан ни один тег. Уровень позиции виден в карточке.',
    table: {
      title: `Позиции без тега${typeSuffix}`,
      columns: ['Позиция', 'Тип', 'Система', 'Моноблок'],
      rows: res.items.map((c) => [c.name, c.equipType, c.systemName, c.monoblockName]),
      total,
      note: res.truncated ? `Показаны первые 200 из ${total}; уточните запрос, чтобы сузить список.` : undefined,
    },
    actions: [
      { kind: 'navigate', label: 'Открыть Оборудование', route: '/equipment' },
      exportAction(type ? `Без тега — ${type}` : 'Позиции без тега'),
    ],
    source: sourceOf(ctx, 'Оборудование проекта'),
  }), ctx, { intent: 'equipment_no_tag', label: type ? `Без тега — ${type}` : 'Позиции без тега', equipmentType: type, untagged: true });
}

async function characteristicAnswer(p: ParsedQuestion, ctx: AskContext): Promise<GuideMessage> {
  const field: FieldType | undefined = p.fields[0];

  // «У <тег> расход» — сначала тег, потом его характеристика
  if (p.codes.length) {
    const lookup = await guideTagLookup(ctx.userId, ctx.projectId!, p.codes[0]);
    if (lookup.status !== 'ok') {
      return say(`Тега «${p.codes[0]}» в проекте нет — характеристику показать не для чего.`, { status: 'no-match', source: sourceOf(ctx, 'Теги проекта') });
    }
    const place = (lookup.places || [])[0];
    if (!place) return say(`У тега «${p.codes[0]}» нет привязанной позиции оборудования, характеристик нет.`, { status: 'no-match', source: sourceOf(ctx, 'Теги проекта') });
    if (!field) {
      return say(`Характеристики позиции ${place.component} (тег ${p.codes[0]}):`, {
        table: { title: `Характеристики · ${place.component}`, columns: ['Группа', 'Параметр', 'Значение', 'Ед.'], rows: place.specs.slice(0, 200).map((s) => [s.group, s.key, s.value, s.unit]), total: place.specsTotal, note: place.specsTotal > 200 ? `Показаны первые 200 из ${place.specsTotal}.` : undefined },
        actions: [openComponentAction({ id: place.componentId, name: place.component })],
        source: sourceOf(ctx, 'Оборудование проекта'),
      });
    }
    const params: Record<string, string | number> = { componentId: place.componentId };
    if (p.numeric) { params.op = p.numeric.op; params.value = p.numeric.value; if (p.unit) params.unit = p.unit; }
    const row = await guideSpec(ctx.userId, ctx.projectId!, field.keys[0], params);
    if (!row.items.length) {
      return say(`У позиции ${place.component} характеристика «${field.canonical}» отсутствует или не проходит по фильтру.`, {
        status: 'no-match',
        text: `Позиция ${place.component} (тег ${p.codes[0]}): характеристика «${field.canonical}» не заполнена или не соответствует фильтру. Это не «нет доступа» и не сбой.`,
        actions: [openComponentAction({ id: place.componentId, name: place.component })],
        source: sourceOf(ctx, 'Оборудование проекта'),
      });
    }
    const r = row.items[0];
    return say(`${field.canonical}: ${r.value}${r.unit ? ' ' + r.unit : ''}`, {
      outcome: `${field.canonical}: ${r.value}${r.unit ? ' ' + r.unit : ''}`,
      text: `Позиция ${r.name} (${r.system}, тег ${r.tags.join(', ') || '—'}): ${r.field} = ${r.value}${r.unit ? ' ' + r.unit : ''}.`,
      actions: [openComponentAction({ id: r.componentId, name: r.name })],
      source: sourceOf(ctx, 'Оборудование проекта'),
    });
  }

  if (!field) return null;
  const params: Record<string, string | number> = { limit: 200 };
  if (p.numeric) { params.op = p.numeric.op; params.value = p.numeric.value; if (p.unit) params.unit = p.unit; }
  const row = await guideSpec(ctx.userId, ctx.projectId!, field.keys[0], params);
  if (!row.items.length) {
    return say(`Ни у одной позиции проекта характеристика «${field.canonical}» не заполнена.`, { status: 'no-match', source: sourceOf(ctx, 'Оборудование проекта') });
  }
  return withContext(say(`«${field.canonical}» заполнено у ${row.total} поз.`, {
    outcome: `Позиций с «${field.canonical}»: ${row.total}`,
    table: {
      title: field.canonical,
      columns: ['Позиция', 'Тип', 'Система', 'Значение'],
      rows: row.items.map((r: GuideSpecRow) => [`${r.name} (${r.tags.join(', ') || 'без тега'})`, r.equipType, r.system, `${r.value}${r.unit ? ' ' + r.unit : ''}`]),
      total: row.total,
    },
    source: sourceOf(ctx, 'Оборудование проекта'),
  }), ctx, { intent: 'equipment_characteristic', label: `«${field.canonical}»`, field: field.keys[0] });
}

async function missingFieldAnswer(p: ParsedQuestion, ctx: AskContext): Promise<GuideMessage> {
  const field = p.fields[0];
  if (!field) return null;
  const params: Record<string, string | number> = { missing: field.keys[0], limit: 200 };
  if (p.equipmentTypes.length) params.type = p.equipmentTypes[0].canonical;
  const res = await guideComponents(ctx.userId, ctx.projectId!, params);
  const typeSuffix = p.equipmentTypes.length ? ` среди «${p.equipmentTypes[0].canonical}»` : '';
  if (!res.total) {
    return say(`Позиций с незаполненным полем «${field.canonical}»${typeSuffix} нет.`, { source: sourceOf(ctx, 'Оборудование проекта') });
  }
  return say(`«${field.canonical}» не указано у ${res.total} поз.${typeSuffix}`, {
    outcome: `Без «${field.canonical}»: ${res.total}`,
    table: {
      title: `Без «${field.canonical}»`,
      columns: ['Позиция', 'Тип', 'Система', 'Теги'],
      rows: res.items.map((c) => [c.name, c.equipType, c.systemName, c.tags.map((t) => t.identifier).join(', ') || '—']),
      total: res.total,
    },
    actions: [{ kind: 'navigate', label: 'Открыть Оборудование', route: '/equipment' }],
    source: sourceOf(ctx, 'Оборудование проекта'),
  });
}

/** Неоднозначная установка: «какой расход у П1» при двух П1 — уточнение, не угадывание (ТЗ §23-C). */
async function clarifySystemAnswer(p: ParsedQuestion, ctx: AskContext): Promise<GuideMessage | null> {
  const name = p.systemNames[0];
  if (!name) return null;
  const res = await guideComponents(ctx.userId, ctx.projectId!, { q: name, limit: 200 });
  const systems = new Map<string, Array<GuideComponent>>();
  for (const c of res.items) {
    const key = `${c.systemName}`;
    (systems.get(key) || systems.set(key, []).get(key)!).push(c);
  }
  if (systems.size <= 1) return null;
  return say(`В проекте несколько позиций по запросу «${name}» — в разных системах. Уточните, какая нужна:`, {
    status: 'no-match',
    clarify: {
      question: 'Какая система имеется в виду?',
      options: [...systems.keys()].slice(0, 4).map((s) => ({ label: s, query: `${p.raw} в системе ${s}` })),
    },
    source: sourceOf(ctx, 'Оборудование проекта'),
  });
}

async function revisionsAnswer(p: ParsedQuestion, ctx: AskContext): Promise<GuideMessage> {
  const params: Record<string, string | number> = { limit: 10 };
  if (p.codes[0]) params.tag = p.codes[0];
  else if (p.systemNames[0]) params.q = p.systemNames[0];
  else {
    const word = p.normalized.match(/у\s+([а-яa-z0-9\-]+)/i);
    if (word) params.q = word[1];
  }
  if (inc(p.normalized, 'конфликт')) params.conflicts = 1;
  const res = await guideRevisions(ctx.userId, ctx.projectId!, params);
  if (!res.items.length) {
    return say('Изменений характеристик для этого запроса в журнале нет.', {
      text: 'Ревизии записываются при загрузке новых расчётов и правках. Если изменений не было, журнал пуст — моделировать историю Guide не будет.',
      source: sourceOf(ctx, 'Журнал оборудования'),
    });
  }
  const withConflicts = res.items.filter((r) => r.hasConflict);
  const table = {
    title: 'Ревизии позиций',
    columns: ['Позиция', 'Тег', 'Система', 'Изменения (Было → Стало)', 'Когда'],
    rows: res.items.flatMap((r) => {
      const rev = r.revisions[0];
      if (!rev) return [[r.name, r.tags.join(', ') || '—', r.system, r.hasConflict ? '⚠ конфликт ревизии' : '—', '—']];
      const diff = rev.changes.length
        ? rev.changes.slice(0, 3).map((c) => `${c.key}: ${c.old} → ${c.new}`).join('; ') + (rev.changes.length > 3 ? ` (+${rev.changes.length - 3})` : '')
        : 'без изменений значений';
      return [[`${r.name} (v${rev.version})`, r.tags.join(', ') || '—', r.system, diff, new Date(rev.changedAt).toLocaleDateString('ru-RU')]];
    }),
    total: res.total,
  };
  return say(
    withConflicts.length
      ? `Найдено позиций: ${res.total}, из них с конфликтом ревизии: ${withConflicts.length}.`
      : `Последние изменения характеристик: ${res.total} поз.`,
    {
      outcome: `Ревизии: ${res.total} поз.${withConflicts.length ? ` Конфликтов: ${withConflicts.length}` : ''}`,
      text: withConflicts.length
        ? 'Есть позиции с конфликтом ревизии: новая поставка отличается от сохранённых характеристик. Принять или отклонить ревизию может только человек — в карточке позиции.'
        : 'Ревизии записываются при загрузке новых расчётов и правках характеристик.',
      table,
      actions: [
        { kind: 'navigate', label: 'Открыть Оборудование', route: '/equipment' },
        { kind: 'open-article', label: 'Что делать при конфликте', route: '/guide?article=equipment' },
      ],
      source: sourceOf(ctx, 'Журнал оборудования'),
    },
  );
}

async function filesAnswer(p: ParsedQuestion, ctx: AskContext): Promise<GuideMessage> {
  const tag = p.codes[0] || '';
  const q = tag ? '' : (p.systemNames[0] || '');
  const res = await guideFiles(ctx.userId, ctx.projectId!, tag ? { tag } : { q });
  const what = tag ? `тегу «${tag}»` : q ? `запросу «${q}»` : 'запросу';
  if (!res.total) {
    return say(`Файлов по ${what} в проекте не найдено.`, {
      status: 'no-match',
      text: `Файлов по ${what} в проекте нет. Проверьте код тега (латинская B и кириллическая В различаются) и выбранный проект.`,
      source: sourceOf(ctx, 'Проводник проекта'),
    });
  }
  return withContext(say(`Файлов по ${what}: ${res.total}.`, {
    outcome: `Файлов: ${res.total}`,
    table: {
      title: 'Документы',
      columns: ['Файл', 'Папка', 'Ревизия', 'Статус', 'Теги'],
      rows: res.items.map((f) => [f.name, f.folder, f.revision, f.statusCode, [...f.mainTags, ...f.additionalTags].slice(0, 3).join(', ')]),
      total: res.total,
    },
    actions: [{ kind: 'navigate', label: 'Открыть Проводник', route: '/explorer' }],
    source: sourceOf(ctx, 'Проводник проекта'),
  }), ctx, { intent: 'document_search', label: `Файлы по ${what}`, code: tag || undefined, query: q });
}

async function countAnswer(p: ParsedQuestion, ctx: AskContext): Promise<GuideMessage> {
  const summary = await guideSummary(ctx.userId, ctx.projectId!);

  const wantsProcurement = hasAny(p, 'заказ', 'закуп', 'поставщик', 'этап');
  if (wantsProcurement) {
    const stage = STAGE_WORDS.find((s) => s.re.test(p.normalized));
    const tags = await guideTags(ctx.userId, ctx.projectId!, stage ? { stage: stage.stage, limit: 200 } : { limit: 200 });
    if (stage) {
      return say(`На этапе «${tags.items[0]?.stageLabel || stage.stage}»: ${tags.total} тегов.`, {
        outcome: `Этап «${tags.items[0]?.stageLabel || stage.stage}»: ${tags.total}`,
        table: {
          title: `Этап «${tags.items[0]?.stageLabel || stage.stage}»`,
          columns: ['Тег', 'Марка', 'Поставщик', 'Кол-во'],
          rows: tags.items.map((t) => [t.identifier, t.brand || '—', t.supplier || '—', t.qty || '—']),
          total: tags.total,
        },
        actions: [{ kind: 'navigate', label: 'Открыть Менеджмент', route: '/management' }],
        source: sourceOf(ctx, 'Закупки проекта'),
      });
    }
    const byStage = new Map<string, number>();
    for (const s of summary.stages) byStage.set(s.id, 0);
    const all = await guideTags(ctx.userId, ctx.projectId!, { limit: 200 });
    for (const t of all.items) byStage.set(t.stageId, (byStage.get(t.stageId) || 0) + 1);
    return say('Этапы закупки по проекту:', {
      table: {
        title: 'Закупка по этапам',
        columns: ['Этап', 'Тегов'],
        rows: summary.stages.map((s) => [s.label, String(byStage.get(s.id) || 0)]),
        total: all.total,
      },
      actions: [{ kind: 'navigate', label: 'Открыть Менеджмент', route: '/management' }],
      source: sourceOf(ctx, 'Закупки проекта'),
    });
  }

  if (p.equipmentTypes.length) {
    const type = p.equipmentTypes[0];
    const res = await guideComponents(ctx.userId, ctx.projectId!, { type: type.canonical, limit: 0 });
    return withContext(say(`${type.canonical}: ${res.total} поз.`, {
      outcome: `${type.canonical}: ${res.total}`,
      text: `Счёт по классу оборудования «${type.canonical}», а не по совпадению подстроки в названии.`,
      actions: [
        { kind: 'navigate', label: 'Показать в Оборудовании', route: '/equipment' },
        { kind: 'ask', label: 'Показать список', query: `покажи ${type.canonical.toLowerCase()}` },
      ],
      source: sourceOf(ctx, 'Оборудование проекта'),
    }), ctx, { intent: 'project_count', label: type.canonical, equipmentType: type.canonical });
  }
  if (inc(p.normalized, 'файл', 'документ')) {
    const res = await guideFiles(ctx.userId, ctx.projectId!, { q: ' ' }).catch(() => null);
    if (res) {
      return say(`Файлов в проекте: ${res.total}.`, {
        outcome: `Файлов: ${res.total}`,
        actions: [{ kind: 'navigate', label: 'Открыть Проводник', route: '/explorer' }],
        source: sourceOf(ctx, 'Проводник проекта'),
      });
    }
  }
  if (hasAny(p, 'тег')) {
    return say(`Тегов в проекте: ${summary.counts.tags}.`, {
      outcome: `Тегов: ${summary.counts.tags}`,
      text: `Систем: ${summary.counts.systems}, моноблоков: ${summary.counts.monoblocks}, позиций оборудования: ${summary.counts.components}. Дубликатов кодов: ${summary.counts.duplicates}.`,
      actions: [{ kind: 'navigate', label: 'Открыть Теги', route: '/registry' }],
      source: sourceOf(ctx, 'Теги проекта'),
    });
  }
  if (hasAny(p, 'установ', 'систем', 'моноблок')) {
    return say(`Систем в проекте: ${summary.counts.systems}.`, {
      outcome: `Систем: ${summary.counts.systems}`,
      text: `Моноблоков: ${summary.counts.monoblocks}, отдельных позиций оборудования: ${summary.counts.components}. Число систем и число компонентов — разные счётчики.`,
      actions: [{ kind: 'navigate', label: 'Открыть Оборудование', route: '/equipment' }],
      source: sourceOf(ctx, 'Оборудование проекта'),
    });
  }
  return summaryAnswer(ctx);
}

const inc = (s: string, ...needles: string[]): boolean => needles.some((n) => s.includes(n));

const hasAny = (p: ParsedQuestion, ...needles: string[]): boolean =>
  p.stems.some((s) => needles.some((n) => s.startsWith(n) || s.includes(n))) || p.equipmentTypes.length > 0 && needles.some((n) => p.equipmentTypes.some((t) => t.canonical.toLowerCase().includes(n)));

async function listAnswer(p: ParsedQuestion, ctx: AskContext, untagged?: boolean): Promise<GuideMessage> {
  const params: Record<string, string | number> = { limit: 200 };
  if (untagged) params.untagged = 1;
  if (p.equipmentTypes.length) params.type = p.equipmentTypes[0].canonical;
  if (p.systemNames.length) params.q = p.systemNames[0];
  const res = await guideComponents(ctx.userId, ctx.projectId!, params);
  if (!res.total) {
    return say(`Позиций по запросу нет.`, {
      status: 'no-match',
      text: 'По выбранным условиям ничего не найдено. Проверка действительно выполнена — попробуйте смягчить фильтр.',
      source: sourceOf(ctx, 'Оборудование проекта'),
    });
  }
  const type = p.equipmentTypes[0]?.canonical;
  return withContext(say(`Найдено позиций: ${res.total}.`, {
    outcome: `Найдено: ${res.total}${type ? ` · ${type}` : ''}`,
    table: {
      title: type || 'Оборудование проекта',
      columns: ['Позиция', 'Тип', 'Система', 'Теги', 'Марка'],
      rows: res.items.map((c: GuideComponent) => [c.name, c.equipType, c.systemName, c.tags.map((t) => t.identifier).join(', ') || '—', '—']),
      total: res.total,
      note: res.truncated ? `Показаны первые 200 из ${res.total}; уточните запрос, чтобы сузить список.` : undefined,
    },
    actions: [
      { kind: 'navigate', label: 'Открыть Оборудование', route: '/equipment' },
      exportAction(type || 'Оборудование проекта'),
    ],
    source: sourceOf(ctx, 'Оборудование проекта'),
  }), ctx, {
    intent: 'equipment_list', label: type || 'Оборудование проекта',
    equipmentType: type, untagged: !!untagged, systemName: p.systemNames[0],
  });
}

async function summaryAnswer(ctx: AskContext, summary?: Awaited<ReturnType<typeof guideSummary>>): Promise<GuideMessage> {
  const s = summary || await guideSummary(ctx.userId, ctx.projectId!);
  return say(`Проект «${s.project.name}»: тегов ${s.counts.tags}, позиций ${s.counts.components}.`, {
    outcome: `Тегов ${s.counts.tags} · Позиций ${s.counts.components}`,
    cards: [{
      kind: 'project', id: ctx.projectId!, title: s.project.name,
      subtitle: `${s.project.code ? `Код ${s.project.code} · ` : ''}${s.project.customer || 'заказчик не указан'}`,
      fields: [
        { label: 'Теги', value: String(s.counts.tags) },
        { label: 'Системы', value: String(s.counts.systems) },
        { label: 'Моноблоки', value: String(s.counts.monoblocks) },
        { label: 'Позиции оборудования', value: String(s.counts.components) },
        { label: 'Позиции без тега', value: String(s.counts.componentsNoTag) },
        { label: 'Дубликаты тегов', value: String(s.counts.duplicates) },
        { label: 'Конфликты ревизий', value: String(s.counts.conflicts) },
      ],
    }],
    table: s.categories.length ? {
      title: 'Классы оборудования',
      columns: ['Класс', 'Позиций'],
      rows: s.categories.map((c) => [c.type, String(c.count)]),
      total: s.categories.length,
    } : undefined,
    actions: [{ kind: 'navigate', label: 'Открыть Теги', route: '/registry' }, exportAction('Сводка проекта')],
    source: sourceOf(ctx, 'Сводка проекта'),
  });
}

/** Продолжение вопроса: «их», «а только без тегов», «сколько их», «выгрузи» (ТЗ §36.4). */
async function followUpAnswer(p: ParsedQuestion, ctx: AskContext): Promise<GuideMessage[] | null> {
  const last = ctx.lastResult;
  if (!last || last.projectId !== ctx.projectId) return null;
  const n = p.normalized;

  // «выгрузи», «в эксель» — открыть штатную выгрузку с контекстом
  if (inc(n, 'выгрузи', 'эксель', 'excel', 'экспортируй', 'в слово')) {
    return [say(`Открываю штатную «Выгрузку данных» по контексту «${last.label}».`, {
      outcome: 'Выгрузка данных',
      text: 'Строки и столбцы можно проверить перед сохранением. Экспорт берёт все строки выборки, а не только показанную страницу.',
      actions: [{ kind: 'open-export', label: 'Открыть «Выгрузку данных»', route: '/equipment-export', query: last.label }],
      source: { label: 'Flux Guide', at: nowAt() },
    })];
  }
  // «сколько (их)?»
  if (inc(n, 'скольк')) {
    if (last.untagged || inc(n, 'без тег')) return [await noTagAnswer(ctx, last.equipmentType)];
    if (last.equipmentType) {
      const res = await guideComponents(ctx.userId, ctx.projectId!, { type: last.equipmentType, limit: 0 });
      return [say(`${last.equipmentType}: ${res.total} поз.`, { outcome: `${last.equipmentType}: ${res.total}`, source: sourceOf(ctx, 'Оборудование проекта') })];
    }
    return null;
  }
  // «а только без тегов»
  if (inc(n, 'без тег') || (last.equipmentType && inc(n, 'только'))) {
    return [await noTagAnswer(ctx, last.equipmentType)];
  }
  // «покажи их» — повторить список
  if (inc(n, 'покажи их', 'покажи', 'список')) {
    const fake: ParsedQuestion = { ...p, equipmentTypes: last.equipmentType ? EQUIPMENT_TYPES.filter((t) => t.canonical === last.equipmentType) : [], systemNames: last.systemName ? [last.systemName] : [] };
    return [await listAnswer(fake, ctx, last.untagged)];
  }
  return null;
}

// ── Главная точка входа: вопрос → ответ(ы) ──

export async function answerQuestion(question: string, ctx: AskContext): Promise<GuideMessage[]> {
  const text = String(question || '').trim();
  if (!text) return [];

  // Приветствия и служебные фразы — без похода на сервер
  if (/^(привет|здравствуй|добрый (день|вечер|утро)|салют)/i.test(text)) {
    return [say('Здравствуйте! Я Flux Guide: справочник Flux и ответы по данным проекта — без нейросети, только проверенные статьи и данные выбранного проекта.', {
      actions: [{ kind: 'ask', label: 'Что ты умеешь?', query: 'что ты умеешь' }],
    })];
  }
  if (/^(спасибо|благодар)/i.test(text)) return [say('Пожалуйста! Если что-то в ответе непонятно — спросите уточнение, Guide покажет статью справочника.')];
  if (/что ты умеешь|какие вопросы|помоги чем|что можешь/i.test(text)) {
    return [say('Я умею три вещи:\n\n1. Справочник — как выполнить действие в любой программе Flux, с кнопками «Открыть раздел» и «Показать действие».\n2. Данные проекта — теги, оборудование, характеристики, ревизии, документы, закупки, дубликаты: точные ответы по выбранному проекту.\n3. Демонстрации — Guide откроет нужный раздел и подсветит кнопки, действия делаете вы.\n\nПримеры: «Найди тег 3700-B08-DW-002B», «Сколько приточных установок?», «Покажи оборудование без тега», «Какая ревизия у тега …?», «Есть ли файлы у тега …?», «Как выгрузить характеристики в Excel?»', {
      actions: [
        { kind: 'ask', label: 'Сколько тегов в проекте?', query: 'сколько тегов' },
        { kind: 'ask', label: 'Найди дубли тегов', query: 'есть ли дубли тегов' },
        { kind: 'ask', label: 'Как загрузить XML?', query: 'как загрузить xml оборудования' },
      ],
    })];
  }

  const p = parseQuestion(text);

  // Продолжение разговора имеет приоритет: «их», «а без тегов», «выгрузи»
  if (p.isFollowUp && ctx.lastResult) {
    const follow = await followUpAnswer(p, ctx).catch(() => null);
    if (follow) return follow;
  }

  // Проектные намерения требуют явного проекта: молча выбирать первый нельзя
  const projectIntents = new Set(['tag_lookup', 'tag_duplicates', 'equipment_no_tag', 'equipment_missing_field', 'equipment_characteristic', 'equipment_list', 'project_count', 'project_summary', 'procurement_state', 'equipment_revision', 'document_search', 'open_export']);
  if (projectIntents.has(p.intent) && !ctx.projectId) {
    return [say('Для ответа нужен проект — данные не выбираются «по умолчанию». Выберите проект в шапке над строкой ввода и повторите вопрос.', {
      status: 'need-project',
      clarify: { question: 'По какому проекту отвечать?', options: [] },
      source: { label: 'Flux Guide', at: nowAt() },
    })];
  }

  try {
    switch (p.intent) {
      case 'tag_lookup': return [await tagLookupAnswer(p, ctx)];
      case 'tag_duplicates': return [await duplicatesAnswer(ctx)];
      case 'equipment_no_tag': return [await noTagAnswer(ctx, p.equipmentTypes[0]?.canonical)];
      case 'equipment_missing_field': {
        const m = await missingFieldAnswer(p, ctx);
        if (m) return [m];
        break;
      }
      case 'equipment_characteristic': {
        // Неоднозначная система: «расход у П1» при двух П1 — уточнение (ТЗ §23-C)
        const clarify = await clarifySystemAnswer(p, ctx).catch(() => null);
        if (clarify) return [clarify];
        const a = await characteristicAnswer(p, ctx);
        if (a) return [a];
        break;
      }
      case 'equipment_revision': return [await revisionsAnswer(p, ctx)];
      case 'document_search': return [await filesAnswer(p, ctx)];
      case 'open_export': {
        const tour = findBestTour(text, allowEntitlement);
        return [say('Открываю штатную «Выгрузку данных»: строки, столбцы и предпросмотр — перед сохранением.', {
          outcome: 'Выгрузка данных',
          text: 'Guide не создаёт файл сам: выборку и столбцы подтверждаете вы. Экспорт берёт все строки выборки, а не только показанную страницу.',
          actions: [
            { kind: 'open-export', label: 'Открыть «Выгрузку данных»', route: '/equipment-export', query: p.equipmentTypes[0]?.canonical || '' },
            ...(tour && tour.score >= 1.5 ? [{ kind: 'tour' as const, label: `Показать: ${tour.tour.title}`, tourId: tour.tour.id }] : []),
          ],
          source: { label: 'Flux Guide', at: nowAt() },
        })];
      }
      case 'project_count': return [await countAnswer(p, ctx)];
      case 'project_summary': return [await summaryAnswer(ctx)];
      case 'procurement_state': return [await countAnswer(p, ctx)];
      case 'equipment_list': return [await listAnswer(p, ctx)];
      case 'open_section': {
        const s = openSectionAnswer(text);
        if (s) return [s];
        break;
      }
      case 'start_tour': {
        const t = tourAnswer(text);
        if (t) return [t];
        break;
      }
      case 'troubleshoot': {
        const d = diagnosticAnswer(text);
        if (d) return [d];
        const k = knowledgeAnswer(text);
        if (k) return [k];
        const h = handbookAnswer(text, ctx);
        if (h) return [h];
        break;
      }
      case 'glossary': {
        const g = glossaryAnswer(text);
        if (g) return [g];
        const k = knowledgeAnswer(text);
        if (k) return [k];
        const h = handbookAnswer(text, ctx);
        if (h) return [h];
        break;
      }
      case 'knowledge_howto':
      case 'knowledge_where': {
        const t = tourAnswer(text);
        if (t) return [t];
        const k = knowledgeAnswer(text);
        if (k) return [k];
        const h = handbookAnswer(text, ctx);
        if (h) return [h];
        break;
      }
      default: break;
    }
  } catch (err: any) {
    const code = err?.code || '';
    if (code === 'FORBIDDEN') {
      return [say('Нет доступа к данным этого проекта. Guide не показывает ни список, ни количество закрытых объектов.', {
        status: 'permission',
        text: 'Нет доступа к данным проекта. Обратитесь к тому, кто выдаёт права на проект, или выберите другой проект в шапке.',
        source: { label: 'Flux Guide', at: nowAt() },
      })];
    }
    if (code === 'NO_PROJECT') {
      return [say('Проект не выбран. Выберите проект в шапке Flux Guide и повторите вопрос.', { status: 'need-project', source: { label: 'Flux Guide', at: nowAt() } })];
    }
    return [say('Данные проекта сейчас недоступны.', {
      status: 'unavailable',
      text: `Данные проекта недоступны: ${err?.message || 'сервер не отвечает'}. Кэш не выдаётся за свежий результат — повторите запрос, когда связь восстановится.`,
      actions: [{ kind: 'ask', label: 'Повторить', query: text }],
      source: { label: 'Flux Guide', at: nowAt() },
    })];
  }

  // Ответ не найден: не придумываем, предлагаем проверенное (ТЗ §8.4, §34.2-19)
  const fallbackHandbook = handbookAnswer(text, ctx);
  if (fallbackHandbook) return [fallbackHandbook];
  const suggestions: GuideMessage['actions'] = [];
  const tourMatch = findBestTour(text, allowEntitlement);
  if (tourMatch && tourMatch.score >= 1.5) {
    suggestions.push({ kind: 'tour', label: `Демонстрация: ${tourMatch.tour.title}`, tourId: tourMatch.tour.id });
  }
  const field = FIELDS.find((f) => f.stems.some((st) => p.stems.some((s) => s.startsWith(st))));
  if (field) suggestions.push({ kind: 'ask', label: `Где «${field.canonical}» в проекте?`, query: `у каких позиций не указано ${field.canonical.toLowerCase()}` });
  if (p.equipmentTypes.length) suggestions.push({ kind: 'ask', label: `Показать «${p.equipmentTypes[0].canonical}»`, query: `покажи ${p.equipmentTypes[0].canonical.toLowerCase()}` });

  return [say('В проверенной справке нет точного ответа на этот вопрос.', {
    status: 'no-match',
    text: 'В проверенной справке и данных проекта нет точного ответа на этот вопрос. Guide не догадывается — вот что близко по смыслу:',
    actions: suggestions.length ? suggestions : [
      { kind: 'ask', label: 'Сколько тегов в проекте?', query: 'сколько тегов' },
      { kind: 'ask', label: 'Как загрузить XML оборудования?', query: 'как загрузить xml оборудования' },
    ],
    clarify: {
      question: 'Попробуйте переформулировать — или проверьте эти темы:',
      options: [
        { label: 'Сводка проекта', query: 'покажи сводку проекта' },
        { label: 'Дубли тегов', query: 'есть ли дубли тегов' },
        { label: 'Оборудование без тега', query: 'покажи оборудование без тега' },
      ],
    },
    source: { label: 'Flux Guide', at: nowAt() },
  })];
}
