/** Мелкие чистые помощники рабочего окна Studio (проверяются в scripts/test-studio-workspace-ui-logic.ts) */
import type { FileLanguage } from '../editors/CodeView';
import type { AnchoredNote } from '../../shared/ownerNotes';

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's',
  т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Идентификатор программы из названия: человеку не нужно придумывать латинское имя (латиница, цифры, дефис) */
export function slugFromName(name: string): string {
  const latin = [...name.toLowerCase()].map(ch => TRANSLIT[ch] ?? ch).join('');
  const slug = latin.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return /^[a-z]/.test(slug) ? slug : slug ? `app-${slug}` : '';
}

/** Следующий номер версии: 0.1.0 → 0.1.1 */
export function nextVersion(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : version;
}

/** Язык подсветки по имени файла; null — файл не текстовый или слишком чужой, редактор не открывается */
export function languageOfFile(path: string): FileLanguage {
  const ext = (path.split('.').pop() || '').toLowerCase();
  if (['ts', 'tsx'].includes(ext)) return 'typescript';
  if (['js', 'mjs'].includes(ext)) return 'javascript';
  if (ext === 'json') return 'json';
  if (['html', 'svg', 'xml'].includes(ext)) return 'html';
  if (ext === 'css') return 'css';
  if (ext === 'py') return 'python';
  if (ext === 'rs') return 'rust';
  if (['c', 'h'].includes(ext)) return 'c';
  if (['cpp', 'hpp'].includes(ext)) return 'cpp';
  if (ext === 'go') return 'go';
  if (ext === 'cs') return 'csharp';
  if (ext === 'sh') return 'shell';
  if (ext === 'toml') return 'toml';
  return 'plain';
}

export const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg)$/i;
export const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

export interface Problem { source: string; title: string; detail: string; path?: string; line?: number }

/** «файл:строка» в тексте проверки или сборки → переход к месту; без него проблема открывается в «Публикации» */
export function locate(detail: string): { path?: string; line?: number } {
  const m = /([A-Za-z0-9_][A-Za-z0-9_./-]*\.[A-Za-z0-9]{1,5}):(\d+)(?::\d+)?/.exec(detail);
  if (m) return { path: m[1], line: Number(m[2]) };
  const f = /\b((?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:json|ts|js|html|css|py|rs|go|cs|c|cpp))\b/.exec(detail);
  return f ? { path: f[1] } : {};
}

/** Отчёт проверки → список «Проблемы»: только то, что не прошло */
export function problemsOf(report: { items: Array<{ id: string; title: string; status: string; detail: string }> }): Problem[] {
  return report.items.filter(i => i.status === 'fail').map(i => ({ source: 'Проверка', title: i.title, detail: i.detail, ...locate(i.detail) }));
}

/** Замечания владельца → строки списка с переходом к файлу и строке */
export function reviewProblems(review: { note: string; comments: Array<{ path: string; line: number | null; text: string }> } | null): Problem[] {
  if (!review) return [];
  return review.comments.map(c => ({ source: 'Владелец', title: c.text, detail: '', path: c.path, line: c.line ?? undefined }));
}

/** Замечание владельца, перенесённое на сегодняшние файлы (studio/shared/ownerNotes.ts) → строка списка «Замечания» */
export function noteProblems(notes: AnchoredNote[]): Problem[] {
  return notes.map(n => ({
    source: 'Владелец', title: n.text, path: n.fileGone ? undefined : n.path, line: n.currentLine ?? undefined,
    detail: n.fileGone ? `Файла ${n.path} больше нет в проекте.` : n.changed ? `Строка с тех пор изменилась${n.line && n.line !== n.currentLine ? ` (в отправленной версии это строка ${n.line})` : ''}.` : n.line === null ? 'Замечание ко всему файлу.' : '',
  }));
}

/** Файл TypeScript проекта (не объявление типов): ради него появляется кнопка «Собрать» */
export const isTsSource = (path: string) => /\.(ts|tsx)$/.test(path) && !/\.d\.ts$/.test(path);

/** Ответ действия «build» главного процесса */
export interface BuildReport { ok: boolean; files: string[]; problems: Array<{ path: string; line: number; column: number; text: string }>; built: string[]; historyError?: string }

/** Ошибки сборки → строки «Проблем»: файл и строка открывают редактор на месте ошибки */
export function buildProblems(list: BuildReport['problems']): Problem[] {
  return list.map(p => ({ source: 'Сборка', title: p.text, detail: '', path: p.path || undefined, line: p.line || undefined }));
}
