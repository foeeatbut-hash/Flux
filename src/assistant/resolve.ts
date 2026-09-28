import { findKnowledge, matchKnowledge } from './knowledge';
import { findBestTour } from './tours';
import { parse, hasIntent, fieldMatchesStems } from './nlp';
import { FIELDS, FieldDef } from '../import/dictionary';
import { fetchAssistantData, renameTagApi, validateTagCode, type AssistantData } from './data';
import { askedField, specForField, findComponentByCode, tagWithoutEquipment } from './specAnswers';
import { asksWhereWritten } from './handbookAnswers';
import { asksToFindMail } from './mailQueries';
import { handbookMessage, mailSearchMessage } from './answers';
import { uid, type AssistantAction, type AssistantTable, type AssistantListItem, type AssistantMessage, type LastResult, type PendingInput } from './types';
import { ROUTE_WORDS, tokensFrom, isServiceWord } from './queryWords';
import { repairTypos, stripPoliteness } from './inputRepair';

/**
 * Разбор вопроса и подбор ответа. Вынесено из хранилища: это чистая функция
 * «текст и данные → ответ», хранилище нужно ей только ради проверки прав на
 * статьи руководства — её передаёт вызывающий (см. resolveQueryWith).
 */

// Результат распознавания: сообщение + (опционально) контекст последнего списка
// + (опционально) переход в режим ожидания ввода (диалоговое действие)
export interface Resolved { message: AssistantMessage; result?: LastResult | null; pending?: PendingInput; }
const msg = (text: string, extra: Partial<AssistantMessage> = {}): Resolved =>
  ({ message: { id: uid(), role: 'assistant', text, ...extra } });

const EXPORT_ACTIONS: AssistantAction[] = [
  { label: 'Выгрузить в Excel', kind: 'export-excel' },
  { label: 'Выгрузить в Word', kind: 'export-word' },
];
// Ответы про характеристики позиции («какой расход у 3700-…») собраны
// в src/assistant/specAnswers.ts — там же словарь величин и справочник обозначений

/** Разговорные обороты, на которые нельзя отвечать «не понял». */
const SMALL_TALK: { test: RegExp; reply: () => string }[] = [
  { test: /^(привет|здравств|добрый (день|вечер|утр)|хай)/i,
    reply: () => 'Здравствуйте. Спрашивайте про данные проекта обычными словами — найду и покажу.' },
  { test: /(спасиб|благодар|отлично|супер|класс|понятно)/i,
    reply: () => 'Рад помочь. Если что-то ещё нужно найти — спрашивайте.' },
  { test: /(как дела|как ты|ты живой|ты человек|кто ты|ты бот|ты робот)/i,
    reply: () => 'Я помощник внутри программы: работаю на этом компьютере, без интернета. Языковой модели во мне нет — я разбираю вопрос по словам и ищу в данных проекта. Поэтому лучше всего отвечаю на вопросы про теги, оборудование, закупки, документы и файлы.' },
  { test: /(^пока$|до свидан|всего доброго)/i,
    reply: () => 'До связи. Ctrl+K — и я снова тут.' },
  { test: /(извин|прости|сорри)/i,
    reply: () => 'Ничего страшного. Что найти?' },
  { test: /(ты (можешь|умеешь) (всё|все)|любой вопрос|что угодно)/i,
    reply: () => 'Отвечу не на всё: я не языковая модель и не выхожу в интернет. Зато знаю данные этого проекта — теги, оборудование, закупки, документы, файлы — и разделы программы. Спросите, например: «что не заказано» или «где 3700-K02».' },
];

function smallTalkAnswer(lower: string): string | null {
  for (const st of SMALL_TALK) if (st.test.test(lower)) return st.reply();
  return null;
}

// --- Распознавание запроса (полностью локальное) ---
// injectedData — тестовый шов: подставить данные вместо обращения к серверу.
export async function resolveQueryWith(
  allowEntitlement: (entitlement: string) => boolean,
  text: string, demoMode = false, lastResult: LastResult | null = null,
  injectedData?: AssistantData,
): Promise<Resolved> {
  // Живая речь: убираем вежливые обороты, чиним опечатки, отвечаем на
  // разговорное — и только потом разбираем как запрос к данным.
  const talk = smallTalkAnswer(text.toLowerCase());
  if (talk) return msg(talk);
  // Дальше по всей функции работаем с очищенным текстом: иначе разбор
  // спотыкается о «слушай», «а можешь», «пожалуйста» — их пишут постоянно.
  text = repairTypos(stripPoliteness(text));
  const lower = text.toLowerCase().replace(/ё/g, 'е');
  const p = parse(text);
  const getData = () => injectedData ? Promise.resolve(injectedData) : fetchAssistantData();

  // Режим «Демонстрация»: любой вопрос → ближайшая по смыслу демонстрация
  if (demoMode) {
    const m = findBestTour(text, allowEntitlement);
    if (m && m.tour) {
      return msg(
        m.score >= 1.5 ? m.tour.intro : `Похоже, вам подойдёт демонстрация «${m.tour.title}». ${m.tour.intro}`,
        { actions: [{ label: '▶ Показать демонстрацию', kind: 'tour', tourId: m.tour.id }] }
      );
    }
    return msg('Не нашёл подходящую демонстрацию. Попробуйте, например, «как добавить тег» или «как импортировать оборудование».');
  }

  // A0. Поиск по почте: «покажи все письма про 20-PT-001», «письма от Иванова».
  //
  // Ищем по всем ящикам, до которых у человека есть доступ, а не только по
  // открытому: в каком ящике лежит нужное письмо — вопрос не к спрашивающему.
  if (asksToFindMail(text)) return { message: await mailSearchMessage(text) };

  // A1. «Где в руководстве написано про …» — руководство отвечает первым
  if (asksWhereWritten(text)) {
    const hb = handbookMessage(text, 2, allowEntitlement);
    if (hb) return { message: hb };
  }

  // A. Навигационная команда: «открой/перейди в <раздел>»
  if (/(^|\s)(открой|открыть|перейд|зайд|покажи раздел|переключ)/.test(lower)) {
    for (const r of ROUTE_WORDS) {
      if (hasIntent(p, r.stems)) {
        return msg(`Открываю раздел «${r.name}».`, {
          actions: [{ label: `Перейти в «${r.name}»`, kind: 'open-section', route: r.route }],
        });
      }
    }
  }

  // B. Команда «создай заметку [про X]»
  if (/(создай|создать|新)\s*(заметк|запис)/.test(lower) || /(заметк|запис).*(создай|добав|нов)/.test(lower)) {
    // \w в JavaScript не включает кириллицу: с ним «заметку про П1» давало
    // заголовок «у про П1» — окончание слова оставалось в тексте заметки.
    const about = text.replace(/^.*?(?:заметк[а-яё]*|запис[а-яё]*)\s*(?:про|об|о)?\s*/i, '').trim();
    const title = about && about.length < 60 ? about : 'Новая заметка';
    return msg(`Создаю заметку${about ? ` «${title}»` : ''} в блокноте.`, {
      actions: [{ label: 'Открыть блокнот', kind: 'create-note', noteTitle: title }],
    });
  }

  // C. Вопрос-определение → справка
  if (/(что так|что эт|для чего|зачем|расскажи|объясни|чем отлич|что значит|как работает)/.test(lower)) {
    const knowledge = findKnowledge(lower);
    if (knowledge) return msg(knowledge);
  }

  // D. Демонстрация: «как …»
  const wantsTour = /(^|[^а-яёa-z])как([^а-яёa-z]|$)/i.test(lower)
    || /(демонстрац|научи|инструкц|покажи как|пошагов)/.test(lower);
  if (wantsTour) {
    const tourM = findBestTour(lower, allowEntitlement);
    const knowM = matchKnowledge(lower);
    // Демонстрация подбирается по пересечению слов, и одного общего слова
    // хватало, чтобы перебить справку: на «как вернуть удалённый файл»
    // открывался показ загрузки файлов — просто потому, что там есть
    // слово «файл». Поэтому когда статья справки зацепилась за длинное
    // конкретное слово, демонстрация должна быть увереннее обычного.
    const strongKnowledge = !!knowM && knowM.score >= 6;
    const need = strongKnowledge ? 3 : 1.5;
    if (tourM && tourM.score >= need) {
      return msg(tourM.tour.intro, { actions: [{ label: '▶ Показать демонстрацию', kind: 'tour', tourId: tourM.tour.id }] });
    }
    if (strongKnowledge) {
      // Демонстрацию не теряем — предлагаем её кнопкой рядом с ответом.
      const extra: AssistantAction[] = tourM && tourM.score >= 1.5
        ? [{ label: '▶ Показать демонстрацию', kind: 'tour', tourId: tourM.tour.id }] : [];
      return msg(knowM!.answer, { actions: extra });
    }
  }

  // D2. Переименование тега: «переименуй 3700-A», «смени код 3700-A на 3700-B»,
  // «поменяй тег 3700-A → 3700-B». Связи сохраняются (хранятся по id тега).
  const renameIntent = /(переимен|renam)/.test(lower)
    || (/(смен|помен|замен|исправ|переправ)\w*/.test(lower) && /(тег|код|назван|номер|марк)/.test(lower));
  if (renameIntent && p.codes.length > 0) {
    const data = await getData();
    const oldCode = p.codes[0];
    const matches = data.tags.filter(t => (t.identifier || '').trim().toLowerCase() === oldCode.toLowerCase());
    if (matches.length === 0) {
      return msg(`Не нашёл тег «${oldCode}» в проекте. Проверьте код или скажите «покажи теги».`);
    }
    // Код-дубликат: нужно выбрать конкретный экземпляр
    if (matches.length > 1) {
      return {
        message: {
          id: uid(), role: 'assistant',
          text: `Код «${oldCode}» встречается ${matches.length} раз — выберите, какой тег переименовать:`,
          list: matches.map(t => ({
            id: t.id, title: t.identifier || oldCode, subtitle: t.mainName || t.department || '', badge: 'дубль',
            actions: [
              { label: 'Переименовать', kind: 'prompt-rename-tag', tagId: t.id, code: t.identifier || oldCode },
              { label: 'На Схеме', kind: 'focus-tag', tagId: t.id },
            ],
          })),
        },
      };
    }
    const tag = matches[0];
    // Явно указан новый код → переименовываем сразу
    if (p.codes.length >= 2) {
      const v = validateTagCode(p.codes[1]);
      if (!v.ok) return msg(`Не могу применить код «${p.codes[1]}»: ${v.error}.`);
      if (v.code.toLowerCase() === oldCode.toLowerCase()) return msg('Новый код совпадает со старым — менять нечего.');
      try {
        const collision = data.tags.filter(t => t.id !== tag.id && (t.identifier || '').trim().toLowerCase() === v.code.toLowerCase()).length;
        await renameTagApi(tag.id, v.code);
        const warn = collision > 0 ? `\n⚠ Такой код уже есть у ${collision} тег(ов) — образовался новый дубль.` : '';
        return {
          message: {
            id: uid(), role: 'assistant',
            text: `✅ Переименовал: «${oldCode}» → «${v.code}». Связи и комментарии сохранены.${warn}`,
            actions: [
              { label: 'Показать на Схеме', kind: 'focus-tag', tagId: tag.id },
              { label: 'Показать дубли', kind: 'ask', query: 'покажи дубли' },
            ],
          },
        };
      } catch (err: any) {
        return msg(`Не удалось переименовать: ${err.message}`);
      }
    }
    // Новый код не указан → входим в диалог: следующая реплика станет новым кодом
    return {
      message: {
        id: uid(), role: 'assistant',
        text: `Введите новый код для тега «${tag.identifier || oldCode}». Связи и комментарии сохранятся.\n(или напишите «отмена»)`,
        actions: [{ label: 'Отмена', kind: 'cancel-input' }],
      },
      pending: { kind: 'rename-tag', tagId: tag.id, oldCode: tag.identifier || oldCode },
    };
  }

  // E0. Характеристики позиции из «Оборудования»: «какой расход у 3700-…»,
  // «характеристики 3700-…», «собери расход и мощность у …» (в т.ч. по нескольким тегам)
  if (p.codes.length > 0) {
    const field = askedField(lower, text);
    const wantsSpecs = !!field || /(характеристик|данные|парам|собери|выпиши|сведени)/.test(lower);
    if (wantsSpecs) {
      const data = await getData();

      // Одна позиция + конкретное поле → короткий ответ
      if (p.codes.length === 1 && field) {
        const comp = findComponentByCode(data.components, p.codes[0]);
        if (comp && comp.specs) {
          const sv = specForField(comp.specs, field);
          if (sv) {
            return msg(`${field.label} у ${p.codes[0]}: ${sv.value}${sv.unit ? ' ' + sv.unit : ''}.`,
              { actions: [{ label: 'Показать в оборудовании', kind: 'focus-equipment', componentId: comp.id, specKey: sv.key }] });
          }
          return msg(`У «${p.codes[0]}» характеристику «${field.label}» не нашёл — показать все характеристики?`,
            { actions: [{ label: 'Все характеристики', kind: 'ask', query: `характеристики ${p.codes[0]}` }] });
        }
        // Характеристики живут у изделия, а не у тега. Спросили про величину,
        // а изделия за тегом нет — так и говорим: раньше здесь молча
        // показывалась карточка тега с этапом закупки, и человек считал, что
        // расход у позиции действительно такой.
        const noComp = tagWithoutEquipment(data, p.codes[0]);
        if (noComp) return { message: noComp };
      }

      // Одна позиция без конкретного поля → все её характеристики
      if (p.codes.length === 1 && !field) {
        const comp = findComponentByCode(data.components, p.codes[0]);
        if (comp && comp.specs && comp.specs.length) {
          const table: AssistantTable = {
            title: `Характеристики ${p.codes[0]}`,
            columns: ['Характеристика', 'Значение', 'Ед.'],
            rows: comp.specs.map(s => [s.key, s.value, s.unit]),
          };
          // Список приходит обрезанным — говорим об этом прямо, иначе обрыв
          // читается как «больше у позиции ничего нет»
          const total = comp.specsTotal ?? comp.specs.length;
          const shown = total > comp.specs.length
            ? `${comp.specs.length} из ${total}`
            : `${comp.specs.length}`;
          return { message: { id: uid(), role: 'assistant', text: `Характеристики «${comp.name || p.codes[0]}»: показано ${shown} параметр(ов).`, table,
            actions: [{ label: 'Показать в оборудовании', kind: 'focus-equipment', componentId: comp.id }, ...EXPORT_ACTIONS] }, result: null };
        }
        const noComp = tagWithoutEquipment(data, p.codes[0]);
        if (noComp) return { message: noComp };
      }

      // Несколько позиций → сводная таблица (по указанному полю или ключевым)
      if (p.codes.length > 1) {
        const cols = field ? [field] : ['airflow', 'pressure', 'power'].map(id => FIELDS.find(f => f.id === id)).filter(Boolean) as FieldDef[];
        const rows: (string | number)[][] = p.codes.map(code => {
          const comp = findComponentByCode(data.components, code);
          return [code, ...cols.map(f => {
            const sv = comp && comp.specs ? specForField(comp.specs, f) : null;
            return sv ? `${sv.value}${sv.unit ? ' ' + sv.unit : ''}` : '—';
          })];
        });
        const table: AssistantTable = { title: field ? `${field.label} по позициям` : 'Характеристики позиций', columns: ['Тег', ...cols.map(f => f.label)], rows };
        return { message: { id: uid(), role: 'assistant', text: `Собрал данные по ${p.codes.length} позиц.`, table, actions: EXPORT_ACTIONS }, result: null };
      }
    }
  }

  // E. Прямой код тега/марки → карточка позиции
  if (p.codes.length > 0) {
    const data = await getData();
    const code = p.codes[0];
    const found = data.tags.filter(t => (t.identifier || '').toLowerCase() === code.toLowerCase()
      || (t.identifier || '').toLowerCase().includes(code.toLowerCase())
      || (t.brand || '').toLowerCase().includes(code.toLowerCase()));
    if (found.length) {
      const t = found[0];
      const dup = data.duplicates.find(d => d.code === (t.identifier || '').trim());
      const actions: AssistantAction[] = [
        { label: 'Открыть на Схеме', kind: 'focus-tag', tagId: t.id },
        { label: 'Показать в Менеджменте', kind: 'open-section', route: '/management' },
      ];
      if (dup) actions.push({ label: `Найти дубли (${dup.count})`, kind: 'find-duplicates', code: dup.code });
      const lines = [
        `${t.identifier}${t.mainName ? ` — ${t.mainName}` : ''}`,
        t.brand ? `Марка: ${t.brand}` : '',
        t.department ? `Отдел: ${t.department}` : '',
        `Актуальность: ${ACTUALITY_RU[t.actuality || 'draft'] || t.actuality}`,
        `Этап закупки: ${t.stageLabel || '—'}${t.supplier ? `, поставщик: ${t.supplier}` : ''}`,
        dup ? `⚠ Дубль кода: встречается ${dup.count} раз(а)` : '',
      ].filter(Boolean);
      return { message: { id: uid(), role: 'assistant', text: lines.join('\n'), actions }, result: { kind: 'tags', ids: found.map(f => f.id), label: code } };
    }
  }

  // F. Follow-up: «а сколько их / выгрузи / покажи их» по прошлому результату
  if (lastResult && /^(а\s+)?(сколько|скольк).{0,6}(их| их\?)?$|^выгруз|^экспорт|^покажи их|^их$/.test(lower.trim())) {
    if (/выгруз|экспорт/.test(lower)) {
      return msg(`Готовлю выгрузку по предыдущему списку «${lastResult.label}» — нажмите кнопку.`, { actions: EXPORT_ACTIONS });
    }
    return msg(`В предыдущем списке «${lastResult.label}»: ${lastResult.ids.length}.`);
  }

  // F2. Вопрос про саму программу: «где корзина», «куда делся файл»,
  // «почему не вижу подборки». Такие вопросы перехватывал поиск по данным
  // и отвечал «по запросу „корзи“ теги не найдены» — человек спрашивал про
  // раздел, а получал пустой список. Поэтому справку с уверенным
  // совпадением спрашиваем до поиска, но только если в вопросе нет кода
  // тега (тогда это точно запрос к данным).
  if (p.codes.length === 0
      && /(^|[^а-яе])(где|куда|откуда|почему|зачем|что делать|не могу найти|не нахожу|не вижу|не работает)([^а-яе]|$)/u.test(lower)) {
    const k = matchKnowledge(lower);
    if (k && k.score >= 6) return msg(k.answer);
  }

  // G. Домены данных
  const wantsData =/(покажи|показать|список|сколько|количеств|выгруз|экспорт|найд|дай|выведи|собери|все|всё|скольк)/.test(lower)
    || hasIntent(p, ['тег', 'оборудован', 'компонент', 'вентилятор', 'установк', 'клапан', 'проект', 'систем', 'дубл', 'закупк', 'критичн', 'внимани', 'проблем', 'заметк', 'этап', 'поставщик'])
    || /не заказан|не куплен|куплен|закуплен|заказан|утвержд|просроч|что изменилос|кто менял|что менял|последн.*(действ|измен|запис)|что требует|требует внимани|конфликт ревиз|завис|застря|не двига|без движ|дольше \d+|больше \d+ дн|на этапе/.test(lower);
  if (wantsData) {
    const data = await getData();
    const c = data.counts;

    // Остаточные стемы — то, что осталось после служебных/доменных слов.
    // Позволяют пересекать фильтры: «критичные ВЕНТИЛЯТОРЫ», «не заказаны КЛАПАНЫ».
    const filterStems = p.stems.filter(s => !isServiceWord(s));
    const tagTextMatch = (t: AssistantData['tags'][number], stems: string[]) =>
      fieldMatchesStems(t.identifier, stems) || fieldMatchesStems(t.brand, stems)
      || fieldMatchesStems(t.mainName, stems) || fieldMatchesStems(t.department, stems)
      || fieldMatchesStems(t.fluid, stems);

    // G1. Сводка/счётчики
    if (hasIntent(p, ['сводк', 'статус']) || /сколько всего|общая|итого|готовност/.test(lower)
        || (/сколько|количеств/.test(lower) && !hasIntent(p, ['дубл', 'критичн', 'закупк', 'вентилятор', 'клапан', 'установк']))) {
      const problems = (c.critical || 0) + (c.duplicates || 0);
      return msg(
        `Сводка по активному проекту:\n• Тегов: ${c.tags}\n• Оборудования: ${c.components}\n• Систем: ${c.systems}\n• Файлов: ${c.files}, заметок: ${c.notes}\n` +
        `${problems > 0 ? `\n⚠ Требуют внимания: критичных ${c.critical || 0}, дублей ${c.duplicates || 0}.` : '\n✓ Критичных позиций и дублей нет.'}`,
        { actions: problems > 0 ? [{ label: 'Показать дубли', kind: 'ask', query: 'покажи дубли' }, { label: 'Показать критичные', kind: 'ask', query: 'критичные позиции' }] : [] }
      );
    }

    // G2. Дубли
    if (hasIntent(p, ['дубл'])) {
      if (data.duplicates.length === 0) return msg('Дубликатов кодов тегов в проекте нет — все коды уникальны. 👍');
      const tagById: Record<string, AssistantData['tags'][number]> = {};
      for (const t of data.tags) tagById[t.id] = t;
      // Раскрываем группы дублей в отдельные экземпляры с кнопками действий
      const list: AssistantListItem[] = [];
      for (const d of data.duplicates) {
        d.ids.forEach((id, i) => {
          const t = tagById[id];
          list.push({
            id,
            title: t?.identifier || d.code,
            subtitle: `${t?.mainName || t?.department || 'без наименования'} · экземпляр ${i + 1} из ${d.count}`,
            badge: 'дубль',
            actions: [
              { label: 'Переименовать', kind: 'prompt-rename-tag', tagId: id, code: t?.identifier || d.code },
              { label: 'На холсте', kind: 'focus-tag', tagId: id },
            ],
          });
        });
      }
      // Таблица — для выгрузки/контекста (не отображается, когда есть список)
      const table: AssistantTable = {
        title: 'Дубликаты кодов тегов',
        columns: ['Код тега', 'Повторов'],
        rows: data.duplicates.map(d => [d.code, d.count]),
      };
      return {
        message: {
          id: uid(), role: 'assistant',
          text: `Нашёл дублей: ${data.duplicates.length} (всего ${data.duplicates.reduce((s, d) => s + d.count, 0)} позиций).\nНажмите «Переименовать» у любого — я спрошу новый код, а связи сохранятся.`,
          list,
          table,
          actions: EXPORT_ACTIONS,
        },
        result: { kind: 'duplicates', ids: data.duplicates.flatMap(d => d.ids), label: 'дубли' },
      };
    }

    // G3. Проблемы / актуальность (+ пересечение с текстовым фильтром)
    if (hasIntent(p, ['критичн', 'внимани', 'проблем', 'конфликт'])) {
      let bad = data.tags.filter(t => t.actuality === 'critical' || t.actuality === 'warning');
      if (filterStems.length) bad = bad.filter(t => tagTextMatch(t, filterStems));
      const suffix = filterStems.length ? ` по запросу «${filterStems.join(' ')}»` : '';
      if (bad.length === 0) return msg(`Критичных позиций и позиций «на проверку»${suffix} нет. ✓`);
      const table: AssistantTable = {
        title: `Требуют внимания${suffix}`,
        columns: ['Тег', 'Наименование', 'Состояние'],
        rows: bad.map(t => [t.identifier || '', t.mainName || '', ACTUALITY_RU[t.actuality || 'draft'] || '']),
      };
      return {
        message: { id: uid(), role: 'assistant', text: `Требуют внимания${suffix}: ${bad.length} (критичных ${bad.filter(t => t.actuality === 'critical').length}).`, table, actions: EXPORT_ACTIONS },
        result: { kind: 'tags', ids: bad.map(t => t.id), label: 'требуют внимания' },
      };
    }

    // G3.5. Зависшие закупки: позиция стоит на одном этапе слишком долго.
    // Самый частый вопрос снабженца — «что стоит», и раньше на него не было
    // ответа: список этапов показывал, где позиция, но не как давно.
    if (/завис|застря|не двига|без движ|ничего не происходит|дольше \d+|больше \d+ дн/.test(lower)) {
      const data = await getData();
      const days = Number(lower.match(/(\d+)\s*дн/)?.[1] || 14);
      const cut = Date.now() - days * 86400000;
      const stuck = data.tags
        .filter(t => !t.stageIsFinal && t.stageSince && new Date(t.stageSince).getTime() <= cut)
        .map(t => ({ t, days: Math.floor((Date.now() - new Date(t.stageSince as string).getTime()) / 86400000) }))
        .sort((a, b) => b.days - a.days);
      if (stuck.length === 0) {
        return msg(`Позиций, застрявших на этапе дольше ${days} дн., нет — по закупкам всё движется. 👍`);
      }
      const table: AssistantTable = {
        title: `Зависли дольше ${days} дн.`,
        columns: ['Тег', 'Наименование', 'Этап', 'Дней на этапе', 'Поставщик'],
        rows: stuck.map(s => [s.t.identifier || '', s.t.mainName || '', s.t.stageLabel || '', String(s.days), s.t.supplier || '']),
      };
      return {
        message: {
          id: uid(), role: 'assistant',
          text: `Застряли на этапе дольше ${days} дн.: ${stuck.length}. Дольше всех — «${stuck[0].t.identifier}» (${stuck[0].days} дн. на этапе «${stuck[0].t.stageLabel}»).`,
          table,
          actions: [{ label: 'Открыть Менеджмент', kind: 'open-section', route: '/management' }, ...EXPORT_ACTIONS],
        },
        result: { kind: 'tags', ids: stuck.map(s => s.t.id), label: `зависли дольше ${days} дн.` },
      };
    }

    // G4. Закупки / этапы
    if (hasIntent(p, ['закупк', 'этап', 'поставщик']) || /не заказан|не куплен|заказан|куплен|утвержд/.test(lower)) {
      let sel = data.tags;
      let label = 'позиции закупки';
      if (/не заказан|не куплен|осталось|просроч/.test(lower)) { sel = data.tags.filter(t => t.stageId === 'added'); label = 'не заказано'; }
      else if (/куплен|закуплен/.test(lower)) { sel = data.tags.filter(t => t.stageId === 'purchased'); label = 'куплено'; }
      else if (/заказан/.test(lower)) { sel = data.tags.filter(t => t.stageId === 'ordered'); label = 'заказано'; }
      // Пересечение с текстовым фильтром: «не заказаны ВЕНТИЛЯТОРЫ отдела ОВ»
      if (filterStems.length) { sel = sel.filter(t => tagTextMatch(t, filterStems)); label += ` · ${filterStems.join(' ')}`; }
      const table: AssistantTable = {
        title: `Закупки: ${label}`,
        columns: ['Тег', 'Наименование', 'Этап', 'Поставщик'],
        rows: sel.map(t => [t.identifier || '', t.mainName || '', t.stageLabel || '', t.supplier || '']),
      };
      return {
        message: {
          id: uid(), role: 'assistant',
          text: `${label[0].toUpperCase()}${label.slice(1)}: ${sel.length} позиц.`,
          table,
          actions: [{ label: 'Открыть Менеджмент', kind: 'open-section', route: '/management' }, ...EXPORT_ACTIONS],
        },
        result: { kind: 'tags', ids: sel.map(t => t.id), label },
      };
    }

    // G5. Поиск по заметкам
    if (hasIntent(p, ['заметк', 'запис'])) {
      const q = p.stems.filter(s => !['заметк', 'запис', 'блокнот', 'найд', 'поиск'].includes(s) && !isServiceWord(s));
      // Слово в запросе есть, но короткое («заметки П1») — стеммер отбрасывает
      // слова короче трёх букв, поэтому ищем ещё и по исходным словам.
      const words = q.length ? q : p.tokens.filter(t => !['заметки', 'заметку', 'заметка', 'заметок', 'блокнот', 'найди', 'поиск'].includes(t));
      // Просто «покажи заметки» — показываем последние, а не уходим в теги.
      if (words.length === 0) {
        if (!data.notes.length) return msg('Заметок пока нет. Раздел «Блокнот» — там их создают.');
        return msg(`Последние заметки (${data.notes.length}):\n${data.notes.slice(0, 8).map(n => `• ${n.title}`).join('\n')}`, {
          actions: [{ label: 'Открыть блокнот', kind: 'open-section', route: '/notes' }],
        });
      }
      const found = data.notes.filter(n => fieldMatchesStems(n.title, words)
        || words.some(w => (n.title || '').toLowerCase().includes(w)));
      if (found.length === 0) return msg('Заметок по этому запросу не нашёл. Поиск идёт по заголовкам — уточните слово.');
      return msg(`Нашёл заметок: ${found.length}.\n${found.slice(0, 8).map(n => `• ${n.title}`).join('\n')}`, {
        actions: [{ label: 'Открыть заметки', kind: 'open-section', route: '/notes' }],
      });
    }

    // G6. История / последние изменения
    if (hasIntent(p, ['изменени', 'истори', 'изменил']) || /кто менял|что менял|последн.*(действ|измен|запис)|что изменилос/.test(lower)) {
      if (!data.recentLogs.length) return msg('Записей об изменениях пока нет.');
      const items = data.recentLogs.slice(0, 10).map(l => `• ${l.description} — ${l.userName}`);
      return msg(`Последние изменения:\n${items.join('\n')}`);
    }

    // G6.5. Запрос с указанием поля: «теги отдела ОВ», «марка Вентилятор»,
    // «среда вода». Обычный поиск по стемам такое не берёт: сокращения вроде
    // «ОВ» короче трёх букв, и стеммер их выбрасывает. Здесь берём слово
    // после названия поля как есть.
    const FIELD_QUERIES: { re: RegExp; field: 'department' | 'brand' | 'fluid'; name: string }[] = [
      { re: /(?:отдел|департамент)[а-я]*\s+([^\s,.;]+)/u, field: 'department', name: 'отдел' },
      { re: /(?:марк|бренд)[а-я]*\s+([^\s,.;]+)/u, field: 'brand', name: 'марка' },
      { re: /(?:сред|теплоносител|жидкост)[а-я]*\s+([^\s,.;]+)/u, field: 'fluid', name: 'среда' },
    ];
    for (const fq of FIELD_QUERIES) {
      const m = lower.match(fq.re);
      const value = m?.[1]?.trim();
      if (!value || value.length < 2) continue;
      const sel = data.tags.filter(t => (t[fq.field] || '').toLowerCase().replace(/ё/g, 'е').includes(value));
      if (sel.length === 0) {
        const known = [...new Set(data.tags.map(t => t[fq.field]).filter(Boolean))].slice(0, 12);
        return msg(`Тегов с параметром «${fq.name}: ${value}» не нашёл.${known.length ? `\nВ проекте встречаются: ${known.join(', ')}.` : ''}`);
      }
      const table: AssistantTable = {
        title: `Теги · ${fq.name}: ${value}`,
        columns: ['Тег', 'Марка', 'Отдел', 'Среда', 'Этап'],
        rows: sel.map(t => [t.identifier || '', t.brand || '', t.department || '', t.fluid || '', t.stageLabel || '']),
      };
      return {
        message: { id: uid(), role: 'assistant', text: `Нашёл тегов: ${sel.length} (${fq.name}: ${value}).`, table, actions: [...EXPORT_ACTIONS] },
        result: { kind: 'tags', ids: sel.map(t => t.id), label: `${fq.name} ${value}` },
      };
    }

    // G7. Поиск тегов/оборудования (по стемам с синонимами)
    const stems = p.stems.filter(s => !isServiceWord(s));
    const mentionsEquip = hasIntent(p, ['оборудован', 'компонент', 'систем', 'моноблок']);
    const mentionsTag = hasIntent(p, ['тег']);

    const matchedTags = data.tags.filter(tg => stems.length === 0
      || fieldMatchesStems(tg.identifier, stems) || fieldMatchesStems(tg.brand, stems)
      || fieldMatchesStems(tg.department, stems) || fieldMatchesStems(tg.fluid, stems)
      || fieldMatchesStems(tg.mainName, stems));
    const matchedComps = data.components.filter(cm => stems.length === 0
      || fieldMatchesStems(cm.name, stems) || fieldMatchesStems(cm.itemCode, stems)
      || fieldMatchesStems(cm.category, stems) || fieldMatchesStems(cm.systemName, stems)
      || cm.tags.some(tag => fieldMatchesStems(tag, stems)));

    const showTags = mentionsTag || (!mentionsEquip && matchedTags.length >= matchedComps.length);
    if (showTags) {
      if (matchedTags.length === 0) {
        // Прежде чем сказать «не найдено», спрашиваем руководство. Вопрос
        // «чем проектные данные отличаются от общих» доезжал сюда и получал
        // ответ «теги не найдены» — при том, что статья ровно об этом есть.
        const hb = handbookMessage(text, 6, allowEntitlement);
        if (hb) return { message: hb };
        return msg(stems.length ? `По запросу «${stems.join(' ')}» теги не найдены. Попробуйте другое слово или проверьте активный проект.` : 'В активном проекте пока нет тегов.');
      }
      const table: AssistantTable = {
        title: stems.length ? `Теги: ${stems.join(' ')}` : 'Все теги проекта',
        columns: ['Тег', 'Марка', 'Отдел', 'Среда', 'Этап'],
        rows: matchedTags.map(t => [t.identifier || '', t.brand || '', t.department || '', t.fluid || '', t.stageLabel || '']),
      };
      const actions: AssistantAction[] = [...EXPORT_ACTIONS];
      if (matchedTags.length === 1) actions.unshift({ label: 'Открыть на холсте', kind: 'focus-tag', tagId: matchedTags[0].id });
      return {
        message: { id: uid(), role: 'assistant', text: `Нашёл тегов: ${matchedTags.length}${stems.length ? ` по запросу «${stems.join(' ')}»` : ''}.`, table, actions },
        result: { kind: 'tags', ids: matchedTags.map(t => t.id), label: stems.join(' ') || 'все теги' },
      };
    } else {
      if (matchedComps.length === 0) {
        const hb = handbookMessage(text, 6, allowEntitlement);
        if (hb) return { message: hb };
        return msg(stems.length ? `По запросу «${stems.join(' ')}» оборудование не найдено.` : 'В активном проекте пока нет оборудования.');
      }
      const table: AssistantTable = {
        title: stems.length ? `Оборудование: ${stems.join(' ')}` : 'Всё оборудование проекта',
        columns: ['Компонент', 'Код', 'Категория', 'Система', 'Теги'],
        rows: matchedComps.map(cm => [cm.name || '', cm.itemCode || '', cm.category || '', cm.systemName || '', cm.tags.join(', ')]),
      };
      return {
        message: { id: uid(), role: 'assistant', text: `Нашёл компонентов: ${matchedComps.length}${stems.length ? ` по запросу «${stems.join(' ')}»` : ''}.`, table, actions: [{ label: 'Открыть Оборудование', kind: 'open-section', route: '/equipment' }, ...EXPORT_ACTIONS] },
        result: { kind: 'components', ids: matchedComps.map(cm => cm.id), label: stems.join(' ') || 'всё оборудование' },
      };
    }
  }

  // H. База знаний (справка о разделах)
  const knowledge = findKnowledge(lower);
  if (knowledge) return msg(knowledge);

  // H2. Руководство. Двадцать с лишним статей знают заметно больше короткого
  // набора заготовок помощника — прежде чем разводить руками, спрашиваем их.
  // Порог здесь высокий: поиск по руководству отвечает почти на любой набор
  // букв, и без порога к каждому вопросу притягивалась бы какая-нибудь статья.
  const hbFallback = handbookMessage(text, 5, allowEntitlement);
  if (hbFallback) return { message: hbFallback };

  // I. Честное «не знаю»: сначала говорим, что именно поняли из вопроса,
  // и только потом предлагаем темы. «Не понял» без объяснения — самый
  // раздражающий ответ, потому что непонятно, как переспросить.
  const heard = tokensFrom(lower).slice(0, 4);
  const preface = heard.length
    ? `Я разобрал слова: ${heard.map(h => `«${h}»`).join(', ')}, но не нашёл по ним ни тегов, ни оборудования, ни закупок в этом проекте. Возможно, стоит спросить иначе — или вот что я точно умею:`
    : 'Я работаю без интернета и отвечаю по данным этого проекта, а не на общие вопросы. Вот что умею:';
  return msg(
    preface,
    {
      actions: [
        { label: 'Показать дубли', kind: 'ask', query: 'покажи дубли' },
        { label: 'Этапы закупки', kind: 'ask', query: 'что не заказано' },
        { label: 'Как импортировать бланк', kind: 'ask', query: 'как импортировать оборудование' },
        { label: 'Что ты умеешь?', kind: 'navigate', route: '__help' },
      ],
    }
  );
}

const ACTUALITY_RU: Record<string, string> = {
  actual: 'актуально', warning: 'проверить', critical: 'критично', info: 'в работе', draft: 'черновик',
};
