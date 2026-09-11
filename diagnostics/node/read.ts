/**
 * Чтение своих записей обратно.
 *
 * Записывать умели, читать — нет. Файлы ротируются по частям и по сеансам,
 * лежат в одной папке, и «прочитать последние десять минут» было некому:
 * приложенный к обращению пакет состоял из одного хвоста окна, а работа
 * сервера, базы и оболочки в него не попадала вовсе.
 *
 * Модуль только для Node: его тянут и оболочка, и сервер. Окно к нему не
 * ходит — у него свой буфер в памяти.
 *
 * Читается ровно то, что уже записано. Событий, отсеянных политикой записи,
 * здесь не появится, и обещать обратное нельзя: чего не записали, того нет.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { DiagnosticEvent } from '../contracts';
import type { SourceName, SourceReport } from '../../feedback/bundleSpec';

/** То же имя, что пишет `FileWriter`: источник, сеанс, часть. */
const FILE_NAME = /^([a-z][a-z0-9-]{0,20})-([0-9a-f-]{36})-(\d{6})\.jsonl$/;

export interface ReadWindow {
  /** Границы интервала в миллисекундах. */
  from: number;
  to: number;
  /** Только этот сеанс. Пусто — любой. */
  session?: string;
  /**
   * Только события с этими метками связи.
   *
   * Так сервер отдаёт СВОИ записи о работе по запросам этого человека, а не
   * весь свой журнал: в нём лежит работа всех сотрудников сразу.
   */
  traceIds?: string[];
  /** Сколько байтов готовы отдать. */
  maxBytes: number;
}

interface Collected {
  events: DiagnosticEvent[];
  bytes: number;
  broken: number;
  /** Сколько подходящих записей не поместилось в предел. */
  omitted: number;
  /** Файлы, которые не удалось прочесть. */
  failed: string[];
  /** Нашлись ли вообще файлы этого источника. */
  files: number;
}

/**
 * Собрать записи источника за интервал.
 *
 * Файлы читаются от свежих к старым, а результат отдаётся в прямом порядке:
 * при нехватке места отбрасывается СТАРОЕ, потому что ближе к происшествию —
 * позднее. Отброшенное считается, а не пропадает молча.
 */
async function collect(dir: string, source: string, window: ReadWindow): Promise<Collected> {
  const out: Collected = { events: [], bytes: 0, broken: 0, omitted: 0, failed: [], files: 0 };

  let names: string[] = [];
  try {
    names = (await fs.readdir(dir)).filter((n) => {
      const m = FILE_NAME.exec(n);
      if (!m || m[1] !== source) return false;
      return !window.session || m[2] === window.session;
    });
  } catch (_) {
    // Папки может не быть вовсе — это «источника нет», а не поломка
    return out;
  }
  out.files = names.length;
  if (!names.length) return out;

  // По времени правки: свежие части читаем первыми, старые можем и не успеть
  const stamped: { name: string; at: number }[] = [];
  for (const name of names) {
    try {
      const stat = await fs.lstat(path.join(dir, name));
      // Файл, изменённый раньше начала интервала, целиком в прошлом
      if (stat.mtimeMs < window.from) continue;
      stamped.push({ name, at: stat.mtimeMs });
    } catch (_) { out.failed.push(name); }
  }
  stamped.sort((a, b) => b.at - a.at);

  const traces = window.traceIds && window.traceIds.length ? new Set(window.traceIds) : null;
  const picked: DiagnosticEvent[] = [];

  for (const { name } of stamped) {
    let text = '';
    try {
      text = await fs.readFile(path.join(dir, name), 'utf8');
    } catch (_) { out.failed.push(name); continue; }

    // Внутри файла тоже с конца: последние строки ближе к происшествию
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.trim()) continue;
      let event: DiagnosticEvent;
      try {
        event = JSON.parse(line) as DiagnosticEvent;
      } catch (_) { out.broken++; continue; }

      const at = Date.parse(event.time);
      if (!Number.isFinite(at) || at < window.from || at > window.to) continue;
      if (traces) {
        const trace = (event.data || {}).traceId;
        if (typeof trace !== 'string' || !traces.has(trace)) continue;
      }

      const size = line.length + 1;
      if (out.bytes + size > window.maxBytes) { out.omitted++; continue; }
      out.bytes += size;
      picked.push(event);
    }
  }

  // Обратно в прямой порядок: читали с конца, отдаём как было
  picked.sort((a, b) => {
    const byTime = Date.parse(a.time) - Date.parse(b.time);
    return byTime !== 0 ? byTime : a.seq - b.seq;
  });
  out.events = picked;
  return out;
}

/**
 * Источник целиком: строки и честный отчёт о том, чего в них нет.
 *
 * Отчёт важнее строк. «Файлов нет» и «файлы есть, но за этот интервал пусто» —
 * разные ответы, и разбирающий обязан их различать: в первом случае искать
 * нечего, во втором — записи были и не сохранились.
 */
export async function readSource(
  dir: string, source: SourceName, window: ReadWindow,
): Promise<{ text: string; report: SourceReport }> {
  const got = await collect(dir, source === 'database' ? 'server' : source, window);

  const lines = got.events.map((e) => `${JSON.stringify(e)}\n`);
  const text = lines.join('');
  const sha256 = createHash('sha256').update(text).digest('hex');

  let state: SourceReport['state'] = 'available';
  let reason: string | undefined;
  if (!got.files) {
    state = 'unavailable';
    reason = 'Файлов этого источника нет — записи не велись или уже удалены ротацией';
  } else if (got.failed.length && !got.events.length) {
    state = 'error';
    reason = `Не удалось прочитать ${got.failed.length} файлов`;
  } else if (got.omitted > 0 || got.failed.length) {
    state = 'truncated';
    reason = got.omitted > 0
      ? `Не поместилось ${got.omitted} записей: предел источника ${Math.round(window.maxBytes / 1024 / 1024)} МиБ`
      : `Не удалось прочитать ${got.failed.length} файлов из ${got.files}`;
  } else if (!got.events.length) {
    // Файлы есть, а за интервал пусто. Это не «ошибок не было» — это «не
    // записано», и путать одно с другим нельзя
    state = 'expired';
    reason = 'За этот интервал записей не сохранилось';
  }

  return {
    text,
    report: {
      source,
      state,
      ...(reason ? { reason } : {}),
      events: got.events.length,
      bytes: got.bytes,
      ...(got.broken ? { broken: got.broken } : {}),
      ...(got.omitted ? { omitted: got.omitted } : {}),
      ...(got.events.length
        ? { from: got.events[0].time, to: got.events[got.events.length - 1].time }
        : {}),
      ...(text ? { sha256 } : {}),
    },
  };
}
