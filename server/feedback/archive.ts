/**
 * Пакет обращения для разработчика — одним архивом.
 *
 * Экспорт был один: Markdown с перечнем имён вложений. Имена — это не данные:
 * по списку «диагностика.jsonl, снимок.png» воспроизвести сбой нельзя. Здесь
 * собирается то, с чем можно работать: опись полноты, сырые записи каждого
 * источника, лента событий по времени, сводка и заготовка описания
 * воспроизведения.
 *
 * Два правила, оба про честность:
 *
 * — в `README.md` первым делом сказано, чего в пакете НЕТ. Разбирающий,
 *   открывший архив без ошибок, не должен заключить, что ошибок не было;
 * — стек сопоставляется с картами ТОЙ сборки, на которой сломалось. Её
 *   идентификатор записан в описи; карт в пакете нет, и обещать их нельзя.
 *
 * Право на архив — `feedback.diagnostics`. Проверяется на сервере, а не
 * скрытием кнопки: прямой запрос по адресу никакой кнопки не спрашивает.
 */

import { deflateRawSync } from 'node:zlib';
import { zip, type ZipEntry } from '../../feedback/zip.js';
import {
  ARCHIVE_PARTS, ARCHIVE_RAW_BYTES, BUNDLE_STATE_NAMES, SOURCE_NAMES, SOURCE_STATE_NAMES,
  type BundleManifest, type SourceReport,
} from '../../feedback/bundleSpec.js';
import { reportNumber } from '../../feedback/contracts.js';
import type { DiagnosticEvent } from '../../diagnostics/contracts.js';

/** Что кладём в архив. Собирается вызывающим — здесь только оформление. */
export interface ArchiveInput {
  report: any;
  manifest: Partial<BundleManifest>;
  summary: any;
  /** Сырые записи по источникам: имя файла → содержимое. */
  sources: Record<string, string>;
  /** Имена вложений человека — сами файлы в архив не кладём. */
  attachments: Array<{ displayName: string; byteLength: number; kind: string }>;
  authorName: string;
}

const human = (bytes: number): string =>
  bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МиБ`
    : bytes > 1024 ? `${Math.round(bytes / 1024)} КиБ` : `${bytes} Б`;

/** Строка описи одного источника — та же и в README, и в сводке. */
function sourceLine(one: SourceReport): string {
  const name = SOURCE_NAMES[one.source] || one.source;
  const state = SOURCE_STATE_NAMES[one.state] || one.state;
  const parts = [`- **${name}** — ${state}`];
  if (one.events) parts.push(`, событий ${one.events}, ${human(one.bytes)}`);
  if (one.from && one.to) parts.push(`, покрывает ${one.from} — ${one.to}`);
  if (one.dropped) parts.push(`, потеряно при записи ${one.dropped}`);
  if (one.omitted) parts.push(`, не поместилось ${one.omitted}`);
  if (one.broken) parts.push(`, не разобрано строк ${one.broken}`);
  if (one.reason) parts.push(`\n  ${one.reason}`);
  return parts.join('');
}

function readme(input: ArchiveInput): string {
  const m = input.manifest;
  const sources = (m.sources || []) as SourceReport[];
  const flawed = sources.filter((s) => s.state !== 'available');

  return [
    `# ${reportNumber(input.report.number)} — ${input.report.title}`,
    '',
    '## Чего в этом пакете нет',
    '',
    // Первым разделом намеренно. Пакет без ошибок читается как «ошибок не
    // было», и это самый дорогой неверный вывод из всех возможных
    flawed.length
      ? 'Не все источники приложены целиком. Прежде чем делать выводы, прочитайте это:'
      : 'Все источники приложены целиком — но это не значит, что записано всё:',
    '',
    ...sources.map(sourceLine),
    '',
    '«Не записано» — не то же самое, что «не было». События, отсеянные',
    'политикой записи, восстановить нельзя: их не сохраняли.',
    '',
    '## Обстоятельства',
    '',
    `- Состояние сборки пакета: ${BUNDLE_STATE_NAMES[(m.state || 'PENDING') as keyof typeof BUNDLE_STATE_NAMES] || m.state}`,
    `- Версия программы: ${input.report.appVersion || '—'}`,
    `- Сборка (buildId): ${m.buildId || input.report.buildId || '— не записана'}`,
    `- Раздел: ${input.report.sectionKey || '—'}`,
    `- Когда сломалось: ${input.report.incidentAt || '—'}`,
    `- Когда отправлено: ${input.report.submittedAt || '—'}`,
    `- Запрошенный интервал: ${m.requestedFrom || '—'} — ${m.requestedTo || '—'}`,
    `- Автор: ${input.authorName}`,
    '',
    '**Стек читается картами именно этой сборки.** Карт в пакете нет, и',
    'сопоставлять стек с текущим состоянием кода нельзя: строки разъехались.',
    'Если карт этой сборки не найдётся — читайте исходный стек как есть и',
    'пишите об этом прямо, а не выдавайте догадку за расшифровку.',
    '',
    '## Что в архиве',
    '',
    '- `manifest.json` — опись полноты, машинно читаемая',
    '- `summary.json` — сводка: медленные операции, ошибки, паузы',
    '- `timeline.json` — события всех источников на одной шкале',
    '- `sources/*.jsonl` — сырые записи каждого источника',
    '- `reproduction.md` — что написал человек и заготовка шагов',
    '',
    input.attachments.length
      ? ['## Вложения человека', '',
        'В архив НЕ входят: их скачивают из карточки отдельно — снимок экрана',
        'может содержать чужую переписку, и решать это должен человек.', '',
        ...input.attachments.map((a) => `- ${a.displayName} (${human(a.byteLength)}, ${a.kind})`)].join('\n')
      : '',
    '',
  ].join('\n');
}

function reproduction(input: ArchiveInput): string {
  const steps = (() => {
    try {
      const list = JSON.parse(input.report.reproductionJson || '[]');
      return Array.isArray(list) ? list : [];
    } catch (_) { return []; }
  })();

  return [
    `# Как воспроизвести — ${reportNumber(input.report.number)}`,
    '',
    '## Что написал человек',
    '',
    input.report.description || '—',
    '',
    ...(steps.length ? ['## Шаги, которые он назвал', '', ...steps.map((s: string, i: number) => `${i + 1}. ${s}`), ''] : []),
    ...(input.report.expected ? ['## Ожидалось', '', input.report.expected, ''] : []),
    ...(input.report.actual ? ['## Получилось', '', input.report.actual, ''] : []),
    '## Ограничения воспроизведения',
    '',
    `- Версия: ${input.report.appVersion || '—'}. На другой версии поведение может отличаться.`,
    `- Раздел: ${input.report.sectionKey || '—'}.`,
    '- Данных человека в пакете нет: ни содержимого документов, ни имён файлов.',
    '  Воспроизводить придётся на своих данных, и это может изменить условия.',
    '',
  ].join('\n');
}

/**
 * Лента событий на одной шкале.
 *
 * Порядок внутри процесса — по `seq`, между процессами — по времени, и это
 * названо прямо: часы разных машин расходятся, вычитать их друг из друга
 * нельзя. Связь между машинами даёт только `traceId`.
 */
function timeline(sources: Record<string, string>): unknown {
  const all: DiagnosticEvent[] = [];
  for (const text of Object.values(sources)) {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const one = JSON.parse(line);
        if (one && typeof one === 'object') all.push(one as DiagnosticEvent);
      } catch (_) { /* битую строку в ленту не кладём: она уже посчитана */ }
    }
  }
  all.sort((a, b) => {
    const byTime = Date.parse(a.time) - Date.parse(b.time);
    if (byTime !== 0) return byTime;
    return (a.session === b.session ? a.seq - b.seq : 0);
  });
  return {
    note: 'Порядок внутри процесса — по seq, между процессами — по времени. '
      + 'Часы разных машин расходятся: связь между ними даёт только traceId.',
    events: all.length,
    items: all,
  };
}

/** Собрать архив. Возвращает готовые байты .zip. */
export function buildArchive(input: ArchiveInput): Uint8Array {
  const entries: ZipEntry[] = [
    { name: 'README.md', data: readme(input) },
    { name: 'manifest.json', data: JSON.stringify(input.manifest, null, 2) },
    { name: 'summary.json', data: JSON.stringify(input.summary ?? {}, null, 2) },
    { name: 'timeline.json', data: JSON.stringify(timeline(input.sources), null, 2) },
    { name: 'reproduction.md', data: reproduction(input) },
  ];

  let raw = 0;
  for (const [name, text] of Object.entries(input.sources)) {
    if (!text) continue;
    if (entries.length >= ARCHIVE_PARTS) break;
    raw += text.length;
    if (raw > ARCHIVE_RAW_BYTES) break;
    entries.push({ name: `sources/${name}`, data: text });
  }

  // Сжатие — своё у сервера: JSONL ужимается на порядок, а без него пакет из
  // ста мегабайт записей ехал бы человеку по сети как есть
  return zip(entries, (data) => new Uint8Array(deflateRawSync(Buffer.from(data))));
}
