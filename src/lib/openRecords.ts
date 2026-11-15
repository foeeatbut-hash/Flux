/**
 * Клиент открытых записей: окно сообщает серверу, что у него открыто.
 *
 * Зачем. Пока человек смотрит карточку позиции, коллега не должен молча её
 * удалить (решение владельца: .claude/progress/conflict-details.md, раздел 2).
 * Сервер у каждого свой, общая только база, поэтому «открыто» живёт в общей
 * таблице: окно присылает ПОЛНЫЙ список открытого, сервер ставит этим строкам
 * свежую отметку и убирает остальные строки этого окна. Список, а не «открыл» и
 * «закрыл», — чтобы потерянный запрос не оставил запись занятой навсегда.
 *
 * Когда шлём:
 *  - при смене списка — сразу (PUT);
 *  - пока что-то открыто — каждые `OPEN_BEAT_MS` (15 с), иначе отметка протухнет
 *    (сервер считает её живой 90 с). Пока Flux открыт и на связи, отметки идут и
 *    запись занята сколько угодно: срока освобождения нет;
 *  - при закрытии окна — пустой список маяком (POST с `keepalive`: он доживает
 *    до выгрузки страницы и несёт те же заголовки входа, что и обычный запрос;
 *    `sendBeacon` заголовков не умеет, а без них сервер ответил бы 401).
 *
 * Ошибки сети глотаются: отметка — удобство, а не условие работы. Не дошедшую
 * отметку следующий удар повторит; а если окно закрыли — строка протухнет сама.
 *
 * Модуль без React: наборы гоняют его с подставным `fetch` и таймером.
 */
// Срок удара и пределы — одни для сервера и окна (lib/openRecordTime)
import { OPEN_BEAT_MS } from './openRecordTime';

export const OPEN_RECORDS_URL = '/api/open-records';
export { OPEN_BEAT_MS as OPEN_RECORDS_BEAT_MS };

/** Запись, открытая в окне: модель базы и id. */
export interface OpenRecordRef { model: string; id: string }

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
interface Timers { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void }

export interface OpenRecordsOptions {
  /** Случайный ключ окна; по умолчанию создаётся сам */
  holderKey?: string;
  fetcher?: Fetcher;
  timers?: Timers;
  url?: string;
  beatMs?: number;
}

export interface OpenRecordsClient {
  readonly holderKey: string;
  /** Источник (экран, окно правки) сообщает всё, что держит открытым; пустой список — перестал держать */
  setSource(source: string, records: OpenRecordRef[]): void;
  /** Полный список открытого окном: объединение источников без повторов */
  list(): OpenRecordRef[];
  /** Окно закрывается: сообщить пустой список маяком и остановить удары */
  release(): void;
  /** Окно вернулось из кэша страниц: сообщить список заново */
  resume(): void;
  /** Остановить удары без отправки (размонтирование) */
  stop(): void;
}

function newHolderKey(): string {
  try { return crypto.randomUUID(); } catch { return `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`; }
}

const keyOf = (r: OpenRecordRef) => `${r.model}\u0000${r.id}`;

export function createOpenRecordsClient(options: OpenRecordsOptions = {}): OpenRecordsClient {
  const holderKey = options.holderKey || newHolderKey();
  const url = options.url || OPEN_RECORDS_URL;
  const beatMs = options.beatMs ?? OPEN_BEAT_MS;
  const fetcher: Fetcher = options.fetcher || ((u, i) => fetch(u, i));
  const timers: Timers = options.timers || { set: (fn, ms) => setInterval(fn, ms), clear: (h) => clearInterval(h as any) };

  const sources = new Map<string, OpenRecordRef[]>();
  let beat: unknown = null;
  /** Что сервер знает по последнему принятому запросу; `null` — не знаем (не дошло). Сначала сервер не знает о окне ничего, то есть список пуст */
  let sentKey: string | null = '';
  let inflight = false;
  let again = false;
  let released = false;

  const list = (): OpenRecordRef[] => {
    const seen = new Map<string, OpenRecordRef>();
    for (const records of sources.values()) for (const r of records) if (r?.model && r?.id) seen.set(keyOf(r), { model: r.model, id: r.id });
    return [...seen.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  };
  const listKey = () => list().map(keyOf).join('\n');

  /** Один запрос за раз: два PUT подряд могли бы прийти в обратном порядке, и сервер принял бы старый список как новый. */
  async function send(): Promise<void> {
    if (inflight) { again = true; return; }
    inflight = true;
    try {
      do {
        // Микрозадержка: «снять старое и поставить новое» подряд (смена выбранной позиции) уходит одним запросом
        await Promise.resolve();
        again = false;
        const records = list();
        const key = listKey();
        try {
          const res = await fetcher(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ holderKey, records }) });
          sentKey = res.ok ? key : null;
        } catch { sentKey = null; }
      } while (again);
    } finally { inflight = false; }
  }

  const tick = () => {
    // Пусто и сервер это знает — слать нечего; не дошло прошлое — повторяем и пустое
    if (listKey() === '' && sentKey === '') return;
    void send();
  };
  const startBeat = () => { if (beat === null) beat = timers.set(tick, beatMs); };
  const stopBeat = () => { if (beat !== null) { timers.clear(beat); beat = null; } };

  return {
    holderKey,
    list,
    setSource(source, records) {
      if (records.length) sources.set(source, records); else sources.delete(source);
      // Окно уже закрывается: список запомнен, а слать начнём, если страницу вернут из кэша (resume)
      if (released) return;
      startBeat();
      // Слать при смене списка; тот же список ждёт ближайшего удара
      if (sentKey !== listKey()) void send();
    },
    release() {
      released = true;
      stopBeat();
      sentKey = null;
      try {
        // keepalive: запрос переживает выгрузку страницы; ответ уже никто не прочтёт
        void fetcher(url, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ holderKey, records: [] }) }).catch(() => {});
      } catch { /* страница закрывается: отметка протухнет сама */ }
    },
    resume() {
      released = false;
      sentKey = null;
      startBeat();
      void send();
    },
    stop() { stopBeat(); },
  };
}

let shared: OpenRecordsClient | null = null;

/** Один клиент на окно: у окна один ключ, а источников (экранов, окон правки) может быть несколько. */
export function windowOpenRecords(): OpenRecordsClient {
  if (shared) return shared;
  shared = createOpenRecordsClient();
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => shared?.release());
    window.addEventListener('pageshow', (e) => { if ((e as PageTransitionEvent).persisted) shared?.resume(); });
  }
  return shared;
}
