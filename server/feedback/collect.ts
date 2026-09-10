/**
 * Записи сервера и базы для пакета обращения.
 *
 * Главный вопрос здесь не «как прочитать файлы», а «как не отдать чужое».
 * Журнал сервера общий: в нём вперемешку работа всех сотрудников. Отдать по
 * присланному списку меток связи нельзя — метки лежат во вложении, которое
 * прислал сам автор, и подставить туда чужие может кто угодно.
 *
 * Поэтому принадлежность доказывается записями САМОГО сервера: он пишет в
 * `http.end` идентификатор сотрудника из сессии. Сначала выбираются запросы с
 * нужным `actor`, из них берутся метки связи, и только по этим меткам
 * подбирается остальное — операции базы и события сокета. Присланное клиентом
 * не участвует в отборе вовсе.
 */

import path from 'node:path';
import { readSource } from '../../diagnostics/node/read';
import { serverDiagnostics } from '../diagnostics';
import {
  SOURCE_BYTES, missingSource, type SourceReport,
} from '../../feedback/bundleSpec';
import type { DiagnosticEvent } from '../../diagnostics/contracts';

export interface ServerWindow {
  from: number;
  to: number;
  /** Чьи записи отдаём. Пусто — не отдаём ничего. */
  actorId: string;
}

/** Где лежат файлы диагностики сервера. */
function directory(): string {
  const sink: any = serverDiagnostics();
  const dir = sink?.dir;
  return typeof dir === 'string' ? dir : path.join(process.cwd(), 'logs', 'diagnostics');
}

/**
 * Метки связи запросов этого сотрудника за интервал.
 *
 * Читаем весь свой журнал за окно времени и оставляем только те запросы, где
 * сервер САМ записал этого человека. Дороговато, но иначе принадлежность
 * недоказуема, а недоказуемая принадлежность в общем журнале означает утечку
 * чужой работы.
 */
async function ownTraces(dir: string, window: ServerWindow): Promise<Set<string>> {
  const traces = new Set<string>();
  if (!window.actorId) return traces;

  // Здесь предел выше: это разведка по всему журналу, а не то, что уедет
  const scan = await readSource(dir, 'server', {
    from: window.from, to: window.to, maxBytes: SOURCE_BYTES * 4,
  });
  const { events } = parse(scan.text);
  for (const event of events) {
    const data = (event.data || {}) as Record<string, unknown>;
    if (data.actor !== window.actorId) continue;
    if (typeof data.trace === 'string' && data.trace) traces.add(data.trace);
  }
  return traces;
}

/** Разбор без зависимости от сводки: здесь нужны только объекты. */
function parse(text: string): { events: DiagnosticEvent[] } {
  const events: DiagnosticEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') events.push(parsed as DiagnosticEvent);
    } catch (_) { /* битая строка — не повод отказываться от остальных */ }
  }
  return { events };
}

/**
 * Работа сервера и базы по запросам этого сотрудника.
 *
 * Два источника, потому что два разных вопроса: «сколько занял запрос» и
 * «сколько из этого заняла база». Складывать их в один нельзя — разбирающий
 * должен видеть, где именно ушло время.
 */
export async function collectServerSources(window: ServerWindow): Promise<{
  serverText: string; databaseText: string; reports: SourceReport[];
}> {
  if (!window.actorId) {
    return {
      serverText: '', databaseText: '',
      reports: [
        missingSource('server', 'Автор обращения не определён — записи сервера не отдаются'),
        missingSource('database', 'Автор обращения не определён — записи базы не отдаются'),
      ],
    };
  }

  const dir = directory();
  let traces: Set<string>;
  try {
    traces = await ownTraces(dir, window);
  } catch (failed: any) {
    const why = `Не удалось прочитать журнал сервера: ${String(failed?.message || failed).slice(0, 160)}`;
    return {
      serverText: '', databaseText: '',
      reports: [
        { source: 'server', state: 'error', events: 0, bytes: 0, reason: why },
        { source: 'database', state: 'error', events: 0, bytes: 0, reason: why },
      ],
    };
  }

  if (!traces.size) {
    const why = 'За этот интервал запросов этого сотрудника в журнале сервера нет';
    return {
      serverText: '', databaseText: '',
      reports: [
        { source: 'server', state: 'expired', events: 0, bytes: 0, reason: why },
        { source: 'database', state: 'expired', events: 0, bytes: 0, reason: why },
      ],
    };
  }

  const list = [...traces];
  const picked = await readSource(dir, 'server', {
    from: window.from, to: window.to, traceIds: list, maxBytes: SOURCE_BYTES,
  });

  // Один файл, два источника: разделяем по имени события. `db.op` — работа
  // базы, всё прочее — работа сервера
  const { events } = parse(picked.text);
  const dbLines: string[] = [];
  const srvLines: string[] = [];
  for (const event of events) {
    const line = `${JSON.stringify(event)}\n`;
    if (String(event.event || '').startsWith('db.')) dbLines.push(line);
    else srvLines.push(line);
  }

  const serverText = srvLines.join('');
  const databaseText = dbLines.join('');

  /** Отчёт источника наследует состояние общего чтения: усечение общее. */
  const shape = (source: 'server' | 'database', lines: string[], text: string): SourceReport => ({
    ...picked.report,
    source,
    events: lines.length,
    bytes: text.length,
    ...(lines.length ? {} : {
      state: picked.report.state === 'available' ? 'expired' : picked.report.state,
      reason: source === 'database'
        ? 'Операций базы по этим запросам не записано'
        : 'Записей сервера по этим запросам не сохранилось',
    }),
  });

  return {
    serverText,
    databaseText,
    reports: [shape('server', srvLines, serverText), shape('database', dbLines, databaseText)],
  };
}
