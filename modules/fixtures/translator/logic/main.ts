// Переводчик технических терминов RU <-> EN.
//
// Что умеет: перевод по словарю (фразы и отдельные слова, с учётом окончаний), поиск по части слова,
// подсказки похожих слов, перевод списка строк пачкой («вставил столбец - получил столбец») и список
// слов, которых в словаре нет.
//
// Откуда берёт строки: из состояния программы (state.lines - список или текст по строкам) либо, если
// там пусто, из данных Flux по договору v1 - наименование и параметры позиции, теги, строки спецификации.
// Запрос поиска и направление - state.query и state.direction ('ru-en', 'en-ru' или 'auto').
//
// Ограничения договора v1, из-за которых словарь лежит прямо в этом файле: логика на TypeScript - один
// файл без подключений и без чтения файлов пакета, сети нет, записи в данные Flux нет.
interface Param { group?: string; key?: string }
interface Tag { name?: string; identifier?: string }
interface Input {
  flux?: {
    equipment?: { name?: string; params?: Param[]; tags?: Tag[] } | null;
    tag?: Tag | null;
    specification?: { rows?: Tag[] } | null;
  };
  state?: Record<string, unknown>;
}
type Direction = 'ru-en' | 'en-ru';
type Status = 'full' | 'approx' | 'partial' | 'none' | 'skip';
interface Entry { ru: string; en: string; ruKey: string; enKey: string }

const MAX_LINES = 300;
const MAX_LINE = 200;
const MAX_MISSING = 100;
/** Пометка у строки в результате: полностью переведённая строка идёт без пометки */
const NOTES: Record<Status, string> = { full: '', approx: ' [по основам слов]', partial: ' [частично]', none: ' [нет в словаре]', skip: ' [без слов]' };

const normalize = (text: string) => text.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const isRussian = (text: string) => (text.match(/[а-яё]/gi) || []).length >= (text.match(/[a-z]/gi) || []).length && /[а-яё]/i.test(text);

/** Основа русского слова: окончание срезается, чтобы «датчики давления» находили «датчик давления» */
function stemRu(word: string): string {
  let out = word;
  const ending = ['ами', 'ями', 'ов', 'ев', 'ей', 'ых', 'их', 'ым', 'им', 'ом', 'ем', 'ам', 'ям', 'ах', 'ях', 'ми'].find(e => out.length - e.length >= 4 && out.endsWith(e));
  if (ending) return out.slice(0, -ending.length);
  for (let i = 0; i < 2 && out.length > 3 && 'аеиоуыэюяйь'.includes(out[out.length - 1]); i++) out = out.slice(0, -1);
  return out;
}
/** Английские формы множественного числа: valves -> valve, switches -> switch, supplies -> supply */
function candidatesEn(word: string): string[] {
  const out = [word];
  if (word.endsWith('ies') && word.length > 4) out.push(`${word.slice(0, -3)}y`);
  if (word.endsWith('es') && word.length > 3) out.push(word.slice(0, -2));
  if (word.endsWith('s') && word.length > 3) out.push(word.slice(0, -1));
  return out;
}
const stemPhrase = (phrase: string) => phrase.split(' ').map(stemRu).join(' ');

interface Index { entries: Entry[]; ru: Map<string, Entry>; ruStem: Map<string, Entry>; en: Map<string, Entry> }
let index: Index | null = null;
/** Словарь разбирается один раз: «рус|eng» по строке, строки с # - заголовки разделов */
function dictionary(): Index {
  if (index) return index;
  const entries: Entry[] = [];
  const ru = new Map<string, Entry>(), ruStem = new Map<string, Entry>(), en = new Map<string, Entry>();
  for (const line of DICTIONARY.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [a, b] = line.split('|');
    const entry: Entry = { ru: a, en: b, ruKey: normalize(a), enKey: normalize(b) };
    entries.push(entry);
    if (!ru.has(entry.ruKey)) ru.set(entry.ruKey, entry);
    if (!ruStem.has(stemPhrase(entry.ruKey))) ruStem.set(stemPhrase(entry.ruKey), entry);
    if (!en.has(entry.enKey)) en.set(entry.enKey, entry);
  }
  return (index = { entries, ru, ruStem, en });
}

/** Расстояние Левенштейна с отсечкой: для подсказок нужны только близкие слова */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

/** Похожие записи словаря: по расстоянию до всей записи и до любого её слова, лучшие первыми */
function similar(word: string, direction: Direction, count: number): Entry[] {
  const limit = Math.max(1, Math.floor(word.length / 4));
  const scored: Array<{ entry: Entry; score: number }> = [];
  for (const entry of dictionary().entries) {
    const key = direction === 'ru-en' ? entry.ruKey : entry.enKey;
    let best = distance(word, key, limit);
    for (const part of key.split(' ')) best = Math.min(best, distance(word, part, limit));
    if (best <= limit) scored.push({ entry, score: best });
  }
  scored.sort((a, b) => a.score - b.score || a.entry.ruKey.localeCompare(b.entry.ruKey));
  return scored.slice(0, count).map(item => item.entry);
}

interface Translated { target: string; status: Status; words: number; missing: string[] }
const WORD = /([\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*)/u;

/** Перевод одной строки: самая длинная фраза из словаря (до четырёх слов), знаки и числа остаются как есть */
function translateLine(line: string, direction: Direction): Translated {
  const { ru, ruStem, en } = dictionary();
  const parts = line.split(WORD);
  // Нечётные элементы - слова, чётные - то, что между ними
  const slots: Array<{ text: string; word: boolean; done?: string }> = parts.map((text, i) => ({ text, word: i % 2 === 1 }));
  const own = direction === 'ru-en' ? /^[а-яё-]+$/i : /^[a-z-]+$/i;
  let words = 0, exact = 0, approx = 0;
  const missing: string[] = [];
  const wordSlots = slots.map((slot, i) => (slot.word ? i : -1)).filter(i => i >= 0);
  for (let w = 0; w < wordSlots.length;) {
    const first = slots[wordSlots[w]];
    // Числа, коды и слова чужого алфавита не переводятся и не считаются «нет в словаре»
    if (!own.test(first.text)) { w++; continue; }
    let matched = 0, target = '', byStem = false;
    for (let n = Math.min(4, wordSlots.length - w); n >= 1 && !matched; n--) {
      // Фраза - только слова через один пробел, без знаков препинания между ними
      const phrase = [slots[wordSlots[w]].text];
      let chain = true;
      for (let k = 1; k < n && chain; k++) {
        chain = slots[wordSlots[w + k] - 1].text === ' ' && wordSlots[w + k] - wordSlots[w + k - 1] === 2 && own.test(slots[wordSlots[w + k]].text);
        phrase.push(slots[wordSlots[w + k]].text);
      }
      if (!chain) continue;
      const key = normalize(phrase.join(' '));
      let hit: string | undefined;
      if (direction === 'ru-en') {
        const found = ru.get(key);
        if (found) hit = found.en;
        else { const stemmed = ruStem.get(stemPhrase(key)); if (stemmed) { hit = stemmed.en; byStem = true; } }
      } else {
        // Множественное число - у последнего слова фразы: «pressure sensors» -> «pressure sensor»
        const head = normalize(phrase.slice(0, -1).join(' '));
        const options = candidatesEn(normalize(phrase[phrase.length - 1])).map(last => (head ? `${head} ${last}` : last));
        for (let i = 0; i < options.length && !hit; i++) {
          const found = en.get(options[i]);
          if (found) { hit = found.ru; byStem = i > 0; }
        }
      }
      if (hit) { matched = n; target = hit; }
    }
    if (!matched) {
      // Предлоги и союзы из одной буквы в «нет в словаре» не попадают
      if (first.text.length >= 2) { missing.push(normalize(first.text)); words++; }
      w++; continue;
    }
    // Заглавная первая буква исходного слова сохраняется: «Датчик» -> «Sensor»
    const cased = /^[A-ZА-ЯЁ]/.test(first.text) ? target[0].toUpperCase() + target.slice(1) : target;
    slots[wordSlots[w]].done = cased;
    for (let k = 1; k < matched; k++) slots[wordSlots[w + k]].done = '';
    // Пробел перед выброшенным словом тоже уходит
    for (let k = 1; k < matched; k++) slots[wordSlots[w + k] - 1].done = '';
    words += matched;
    if (byStem) approx++; else exact++;
    w += matched;
  }
  const target = slots.map(slot => slot.done ?? slot.text).join('');
  const translated = exact + approx;
  const status: Status = !words ? 'skip' : !translated ? 'none' : missing.length ? 'partial' : approx ? 'approx' : 'full';
  return { target: status === 'skip' ? line : target, status, words, missing };
}

/** Строки для перевода: из state.lines, а если их там нет - из данных Flux */
function collectLines(input: Input): { lines: string[]; source: string; truncated: boolean } {
  const state = input.state || {};
  const raw = state.lines;
  let lines: string[] = [];
  let source = '';
  if (Array.isArray(raw)) lines = raw.filter((v): v is string => typeof v === 'string');
  else if (typeof raw === 'string') lines = raw.split(/\r?\n/);
  if (lines.some(line => line.trim())) source = 'Список строк';
  else {
    const flux = input.flux || {};
    const equipment = flux.equipment;
    const names = new Set<string>();
    const add = (value: unknown) => { if (typeof value === 'string' && value.trim()) names.add(value.trim()); };
    if (equipment) {
      add(equipment.name);
      for (const p of equipment.params || []) add(p.group);
      for (const p of equipment.params || []) add(p.key);
      for (const t of equipment.tags || []) add(t.name);
      source = 'Позиция оборудования';
    }
    if (flux.tag) { add(flux.tag.name); source = source || 'Тег'; }
    for (const row of flux.specification?.rows || []) add(row.name);
    if (flux.specification?.rows?.length && !equipment && !flux.tag) source = 'Спецификация проекта';
    lines = [...names];
  }
  const clean = lines.map(line => line.replace(/\t/g, ' ').trim().slice(0, MAX_LINE));
  const kept = clean.filter(line => line);
  return { lines: kept.slice(0, MAX_LINES), source: source || 'Нет данных', truncated: kept.length > MAX_LINES };
}

/** Поиск по части слова: записи словаря, где запрос встречается в русском или английском слове; лучшие совпадения первыми */
function search(query: string, direction: Direction) {
  const key = normalize(query);
  const rank = (entry: Entry): number => {
    const own = direction === 'ru-en' ? entry.ruKey : entry.enKey;
    const other = direction === 'ru-en' ? entry.enKey : entry.ruKey;
    if (own === key) return 0;
    if (own.startsWith(key)) return 1;
    if (own.split(' ').some(part => part.startsWith(key))) return 2;
    if (own.includes(key)) return 3;
    if (other.includes(key)) return 4;
    return 9;
  };
  const found = dictionary().entries.map(entry => ({ entry, rank: rank(entry) })).filter(item => item.rank < 9)
    .sort((a, b) => a.rank - b.rank || a.entry.ruKey.localeCompare(b.entry.ruKey));
  return { count: found.length, shown: found.slice(0, FOUND_FIELDS).map(item => item.entry) };
}

/**
 * Форма Flux v1 выводит таблицы только из данных Flux, а результат расчёта - только отдельными полями.
 * Поэтому результат лежит в нумерованных полях row1..row40, gap1..gap20, found1..found10, similar1..similar5
 * (в form.json их столько же, пустые не показываются), а полный столбец перевода - строкой column.
 */
const ROW_FIELDS = 40, GAP_FIELDS = 20, FOUND_FIELDS = 10, SIMILAR_FIELDS = 5;
const numbered = (prefix: string, items: string[], count: number) =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}${i + 1}`, items[i] ?? '']));
const more = (items: unknown[], count: number) => (items.length > count ? `Ещё ${items.length - count}: не помещаются в форму` : '');

export function compute(input: Input) {
  const state = input?.state || {};
  const wanted = state.direction === 'ru-en' || state.direction === 'en-ru' ? state.direction : 'auto';
  const { lines, source, truncated } = collectLines(input || {});
  const rows: string[] = [], targets: string[] = [];
  const counts: Record<Status, number> = { full: 0, approx: 0, partial: 0, none: 0, skip: 0 };
  const missing = new Map<string, number>();
  let words = 0;
  for (const line of lines) {
    const direction: Direction = wanted === 'auto' ? (isRussian(line) ? 'ru-en' : 'en-ru') : wanted;
    const result = translateLine(line, direction);
    counts[result.status]++;
    words += result.words;
    for (const word of result.missing) missing.set(`${direction}:${word}`, (missing.get(`${direction}:${word}`) || 0) + 1);
    targets.push(result.target);
    rows.push(`${line} \u2192 ${result.target}${NOTES[result.status]}`);
  }
  const gaps = [...missing.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_MISSING).map(([key, times]) => {
    const [direction, word] = [key.slice(0, 5) as Direction, key.slice(6)];
    const hints = similar(word, direction, 3).map(entry => (direction === 'ru-en' ? `${entry.ru} = ${entry.en}` : `${entry.en} = ${entry.ru}`));
    return { word, times, text: `${word}${times > 1 ? ` (${times} раз)` : ''}${hints.length ? `: похожие - ${hints.join('; ')}` : ''}` };
  });
  const query = typeof state.query === 'string' ? state.query.trim().slice(0, 80) : '';
  const queryDirection: Direction = wanted === 'auto' ? (isRussian(query) ? 'ru-en' : 'en-ru') : wanted;
  const hits = query ? search(query, queryDirection) : { count: 0, shown: [] as Entry[] };
  const suggestions = query && !hits.count ? similar(normalize(query), queryDirection, SIMILAR_FIELDS) : [];
  const pair = (entry: Entry) => `${entry.ru} = ${entry.en}`;
  const out = {
    source, truncated: truncated ? `Показаны первые ${MAX_LINES} строк` : '',
    total: lines.length, full: counts.full, approx: counts.approx, partial: counts.partial, none: counts.none, skipped: counts.skip,
    words, missingWords: gaps.reduce((sum, gap) => sum + gap.times, 0), dictionarySize: dictionary().entries.length,
    column: targets.join('\n'),
    ...numbered('row', rows, ROW_FIELDS), moreRows: more(rows, ROW_FIELDS),
    ...numbered('gap', gaps.map(gap => gap.text), GAP_FIELDS), moreGaps: more(gaps, GAP_FIELDS),
    query, foundCount: hits.count, ...numbered('found', hits.shown.map(pair), FOUND_FIELDS), moreFound: hits.count > FOUND_FIELDS ? `Ещё ${hits.count - FOUND_FIELDS}: не помещаются в форму` : '',
    similarCount: suggestions.length, ...numbered('similar', suggestions.map(pair), SIMILAR_FIELDS),
  };
  return { state: { ...state }, calc: { out } };
}

// Обработчик для формы: при открытии и при каждом изменении данных читает то, что разрешено договором, и считает
export function setup({ flux, state, calc }: { flux: { read(resource: string): Promise<unknown>; on(event: 'changed', listener: () => void | Promise<void>): void }; state: Record<string, unknown>; calc: { out: Record<string, unknown> } }) {
  flux.on('changed', async () => {
    // Один недоступный ресурс (например, нет открытой позиции) не мешает остальным
    const safe = async (resource: string) => { try { return await flux.read(resource); } catch { return null; } };
    const [equipment, tag, specification] = await Promise.all([safe('equipment'), safe('tag'), safe('specification')]);
    calc.out = compute({ flux: { equipment, tag, specification } as Input['flux'], state }).calc.out;
  });
}

/** Словарь: рус|eng, по одной паре в строке, разделы - строки с #. Пары однозначны в обе стороны */
const DICTIONARY = `
# Союзы и предлоги
и|and
или|or
для|for
с|with
без|without
при|at
основной|main
общий|general
технический|technical
рабочий|working
расчетный|design
номинальный|nominal
максимальный|maximum
минимальный|minimum
входной|inlet
выходной|outlet
центробежный|centrifugal
клиновой|wedge
спиральный|spiral
электрика|electrics
механика|mechanics
очистка|cleaning
# КИПиА
датчик|sensor
преобразователь|transducer
передатчик|transmitter
датчик давления|pressure sensor
датчик температуры|temperature sensor
датчик уровня|level sensor
датчик расхода|flow sensor
датчик положения|position sensor
датчик вибрации|vibration sensor
датчик влажности|humidity sensor
датчик загазованности|gas detector
датчик пламени|flame detector
датчик дыма|smoke detector
датчик скорости|speed sensor
датчик перепада давления|differential pressure sensor
манометр|pressure gauge
термометр|thermometer
термопара|thermocouple
термометр сопротивления|resistance thermometer
термостат|thermostat
расходомер|flowmeter
уровнемер|level gauge
счетчик|meter
регулятор|controller
контроллер|programmable controller
программируемый логический контроллер|programmable logic controller
исполнительный механизм|actuator
привод|drive
пневмопривод|pneumatic actuator
электропривод|electric actuator
гидропривод|hydraulic actuator
позиционер|positioner
регулирующий клапан|control valve
отсечной клапан|shutoff valve
предохранительный клапан|safety valve
обратный клапан|check valve
электромагнитный клапан|solenoid valve
шаровой кран|ball valve
задвижка|gate valve
поворотный затвор|butterfly valve
вентиль|globe valve
клапан|valve
кран|cock
концевой выключатель|limit switch
реле давления|pressure switch
реле уровня|level switch
реле потока|flow switch
реле температуры|temperature switch
реле времени|time relay
сигнализатор|alarm unit
сигнализация|alarm system
защита|protection
блокировка|interlock
уставка|setpoint
диапазон измерения|measuring range
погрешность|error
точность|accuracy
чувствительность|sensitivity
выходной сигнал|output signal
входной сигнал|input signal
токовый сигнал|current signal
аналоговый вход|analog input
аналоговый выход|analog output
дискретный вход|digital input
дискретный выход|digital output
модуль ввода|input module
модуль вывода|output module
шкаф управления|control cabinet
щит управления|control panel
пульт управления|control desk
операторская станция|operator station
диспетчерское управление|supervisory control
автоматизированная система управления|automated control system
система противоаварийной защиты|emergency shutdown system
система сбора данных|data acquisition system
интерфейс оператора|operator interface
мнемосхема|mimic diagram
тревога|alarm
предупреждение|warning
авария|emergency
отказ|failure
калибровка|calibration
поверка|verification
настройка|tuning
измерение|measurement
контроль|monitoring
регулирование|regulating control
управление|control
автоматика|automation
прибор|instrument
средство измерений|measuring instrument
первичный преобразователь|primary transducer
вторичный прибор|secondary instrument
барьер искробезопасности|intrinsic safety barrier
искробезопасная цепь|intrinsically safe circuit
взрывозащита|explosion protection
взрывозащищенное исполнение|explosion-proof design
протокол обмена|communication protocol
шина|bus
полевая шина|fieldbus
промышленная сеть|industrial network
коммутатор|network switch
маршрутизатор|router
сервер|server
резервирование|redundancy
# Трубопроводы и арматура
трубопровод|pipeline
труба|pipe
стальная труба|steel pipe
бесшовная труба|seamless pipe
фитинг|fitting
отвод|elbow
тройник|tee
переход|reducer
заглушка|plug
фланец|flange
прокладка|gasket
крепеж|fasteners
болт|bolt
гайка|nut
шпилька|stud
шайба|washer
сальник|gland
уплотнение|seal
сильфон|bellows
компенсатор|expansion joint
опора|support
подвеска|hanger
хомут|clamp
муфта|coupling
ниппель|nipple
штуцер|nozzle
патрубок|branch pipe
коллектор|manifold
насос|pump
центробежный насос|centrifugal pump
поршневой насос|piston pump
шестеренный насос|gear pump
погружной насос|submersible pump
дозирующий насос|metering pump
компрессор|compressor
вентилятор|fan
воздуховод|air duct
дымовая труба|chimney
теплообменник|heat exchanger
котел|boiler
бак|tank
резервуар|reservoir
емкость|vessel
сосуд под давлением|pressure vessel
реактор|reactor
колонна|column
фильтр|filter
сетчатый фильтр|strainer
сепаратор|separator
отстойник|settling tank
конденсатор|condenser
испаритель|evaporator
градирня|cooling tower
охладитель|cooler
нагреватель|heater
расширительный бак|expansion tank
ресивер|receiver
дренаж|drain
воздушник|air vent
свеча рассеивания|vent stack
факел|flare
сброс|discharge
всасывание|suction
нагнетание|delivery
подача|supply
возврат|return
подающий трубопровод|supply line
обратный трубопровод|return line
напорный трубопровод|pressure line
всасывающий трубопровод|suction line
дренажный трубопровод|drain line
вентиляция|ventilation
отопление|heating
холодоснабжение|cooling supply
водоснабжение|water supply
канализация|sewerage
пожаротушение|fire fighting
сжатый воздух|compressed air
пар|steam
конденсат|condensate
вода|water
питательная вода|feed water
горячая вода|hot water
холодная вода|cold water
техническая вода|process water
питьевая вода|drinking water
сточные воды|wastewater
масло|oil
топливо|fuel
природный газ|natural gas
азот|nitrogen
кислород|oxygen
водород|hydrogen
давление|pressure
рабочее давление|working pressure
расчетное давление|design pressure
пробное давление|test pressure
температура|temperature
рабочая температура|working temperature
расчетная температура|design temperature
расход|flow rate
объемный расход|volumetric flow
массовый расход|mass flow
уровень|level
плотность|density
вязкость|viscosity
номинальный диаметр|nominal diameter
наружный диаметр|outside diameter
внутренний диаметр|inside diameter
толщина стенки|wall thickness
длина|length
ширина|width
высота|height
глубина|depth
масса|mass
вес|weight
объем|volume
площадь|area
материал|material
углеродистая сталь|carbon steel
нержавеющая сталь|stainless steel
чугун|cast iron
медь|copper
алюминий|aluminium
латунь|brass
бронза|bronze
пластик|plastic
полиэтилен|polyethylene
резина|rubber
сварка|welding
сварной шов|weld
резьба|thread
изоляция трубопровода|pipe insulation
теплоизоляция|thermal insulation
антикоррозионное покрытие|anticorrosive coating
окраска|painting
гидравлическое испытание|hydraulic test
пневматическое испытание|pneumatic test
герметичность|tightness
утечка|leak
коррозия|corrosion
износ|wear
# Электрика
электродвигатель|electric motor
асинхронный двигатель|induction motor
генератор|generator
трансформатор|transformer
выключатель|switch
автоматический выключатель|circuit breaker
рубильник|disconnector
разъединитель|isolator
предохранитель|fuse
контактор|contactor
пускатель|motor starter
реле|relay
тепловое реле|thermal relay
преобразователь частоты|frequency converter
устройство плавного пуска|soft starter
источник питания|power source
блок питания|power supply unit
источник бесперебойного питания|uninterruptible power supply
аккумулятор|battery
конденсаторная установка|capacitor bank
шкаф|cabinet
распределительный щит|distribution board
вводное устройство|incoming unit
главный распределительный щит|main switchboard
щит освещения|lighting board
шина заземления|earth bus
сборные шины|busbar
кабель|cable
провод|wire
силовой кабель|power cable
контрольный кабель|control cable
кабель связи|communication cable
витая пара|twisted pair
оптоволокно|optical fiber
жила|conductor core
сечение|cross-section
экран|shield
кабельный лоток|cable tray
кабельный канал|cable duct
кабельная трасса|cable route
кабельный журнал|cable schedule
гофротруба|corrugated conduit
коробка|box
соединительная коробка|junction box
клеммная коробка|terminal box
клемма|terminal
клеммник|terminal block
разъем|connector
вилка|plug connector
розетка|socket
кабельный ввод|cable gland
наконечник|cable lug
заземление|earthing
заземлитель|earth electrode
молниезащита|lightning protection
уравнивание потенциалов|equipotential bonding
напряжение|voltage
ток|current
мощность|power
активная мощность|active power
реактивная мощность|reactive power
полная мощность|apparent power
номинальная мощность|rated power
номинальное напряжение|rated voltage
номинальный ток|rated current
частота|frequency
коэффициент мощности|power factor
сопротивление|resistance
сопротивление изоляции|insulation resistance
емкость конденсатора|capacitance
индуктивность|inductance
постоянный ток|direct current
переменный ток|alternating current
однофазный|single-phase
трехфазный|three-phase
короткое замыкание|short circuit
перегрузка|overload
утечка тока|leakage current
пусковой ток|starting current
освещение|lighting
светильник|luminaire
лампа|lamp
прожектор|floodlight
аварийное освещение|emergency lighting
розеточная сеть|socket network
электроснабжение|electrical supply
электрооборудование|electrical equipment
подстанция|substation
распределительное устройство|switchgear
ячейка|switchgear cell
дизель-генератор|diesel generator
нагрузка|load
потребитель|consumer
кабельная линия|cable line
воздушная линия|overhead line
степень защиты|ingress protection rating
климатическое исполнение|climatic design
класс изоляции|insulation class
# Документация
документ|document
чертеж|drawing
схема|diagram
принципиальная схема|schematic diagram
функциональная схема|functional diagram
структурная схема|block diagram
монтажная схема|wiring diagram
схема соединений|connection diagram
схема расположения|layout diagram
план|plan
разрез|section view
вид|view
узел|detail
спецификация|specification
ведомость|schedule
перечень|list
опросный лист|data sheet
техническое задание|technical specification
технические условия|technical conditions
технический паспорт|technical passport
паспорт|passport
руководство по эксплуатации|operation manual
руководство по монтажу|installation manual
инструкция|instruction
методика|procedure
программа испытаний|test program
протокол испытаний|test report
акт|certificate of acceptance
журнал|log
отчет|report
сертификат|certificate
декларация соответствия|declaration of conformity
пояснительная записка|explanatory note
расчет|calculation
проект|project
рабочая документация|working documentation
проектная документация|design documentation
стадия|stage
раздел|section
том|document volume
лист|sheet
ревизия|revision
версия|version
изменение|change
дата|date
автор|author
разработал|prepared by
проверил|checked by
утвердил|approved by
согласовано|agreed
номер|number
шифр|document code
обозначение|designation
наименование|name
примечание|note
количество|quantity
единица измерения|unit of measure
позиция|item
позиция оборудования|equipment item
тег|tag
тип|type
модель|model
марка|grade
артикул|article number
код|code
производитель|manufacturer
поставщик|supplier
заказчик|customer
подрядчик|contractor
проектировщик|designer
исполнитель|executor
ГОСТ|GOST
стандарт|standard
норма|norm
требование|requirement
допуск|tolerance
класс точности|accuracy class
срок службы|service life
гарантия|warranty
комплект|set
комплектация|configuration
комплектующие|components
запасные части|spare parts
оборудование|equipment
установка|plant
узел учета|metering unit
агрегат|unit assembly
механизм|mechanism
конструкция|structure
монтаж|installation works
демонтаж|dismantling
пусконаладка|commissioning
наладка|adjustment
ввод в эксплуатацию|putting into operation
эксплуатация|operation
техническое обслуживание|maintenance
ремонт|repair
осмотр|inspection
испытание|test
приемка|acceptance
хранение|storage
транспортировка|transportation
упаковка|packaging
маркировка|marking
табличка|nameplate
надпись|inscription
`.trim();
