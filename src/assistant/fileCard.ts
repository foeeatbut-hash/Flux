/**
 * Что помощник говорит про файл, брошенный в разговор.
 *
 * Отдельно от хранилища и без React: сборка ответа — это разбор, а разбор в
 * этом проекте живёт там, где его можно проверить скриптом. Хранилище только
 * ходит в сеть и кладёт готовое сообщение в разговор.
 *
 * Отвечаем тем, что действительно знаем: имя, вид, ревизия, папка, чем
 * открывается и где ещё используется. Придумывать содержание чертежа по его
 * имени — гадание, и здесь этого нет.
 */
import { say, type AssistantMessage } from './types';

export interface FileRecord {
  id: string;
  name?: string;
  type?: string | null;
  refId?: string | null;
  folderId?: string | null;
  folderName?: string | null;
  revision?: string | number | null;
}

export interface FileCard {
  message: AssistantMessage;
  attached: { id: string; title: string; kind: string };
}

const isDocOf = (f: FileRecord) => !!f.refId || f.type === 'CONSTRUCTOR';
const isPdfOf = (f: FileRecord) => f.type === 'PDF' || /\.pdf$/i.test(f.name || '');

/** Вид файла словом — им же подписан значок в Проводнике */
export function kindOf(f: FileRecord): 'doc' | 'pdf' | 'file' {
  if (isDocOf(f)) return 'doc';
  if (isPdfOf(f)) return 'pdf';
  return 'file';
}

/** Адрес, которым файл открывается: тот же, что у двойного нажатия */
export function openRoute(f: FileRecord): string {
  const kind = kindOf(f);
  if (kind === 'doc') return `${String((f as any).filePath || '').startsWith('/doc/') ? '/doc' : '/sheet'}?doc=${encodeURIComponent(f.refId || f.id)}`;
  if (kind === 'pdf') return `/pdf?file=${encodeURIComponent(f.id)}`;
  return `/explorer?file=${encodeURIComponent(f.id)}${f.folderId ? `&folder=${encodeURIComponent(f.folderId)}` : ''}`;
}

export function fileCard(f: FileRecord): FileCard {
  const kind = kindOf(f);
  const what = kind === 'doc' ? 'документ Flux Office' : kind === 'pdf' ? 'чертёж' : 'файл';
  const rev = f.revision ? `, ревизия ${f.revision}` : '';
  const where = f.folderName ? `\nЛежит в папке «${f.folderName}».` : '';
  const name = f.name || 'файл';

  return {
    attached: { id: f.id, title: name, kind },
    message: say(
      `«${name}» — это ${what}${rev}.${where}\n`
      + 'Дальше спрашивайте про него коротко: «где используется», «кто менял» — я держу его в разговоре.',
      {
        actions: [
          {
            label: kind === 'doc' ? 'Открыть в Flux Office' : kind === 'pdf' ? 'Открыть в Просмотре' : 'Показать в Проводнике',
            kind: 'navigate', route: openRoute(f),
          },
          {
            label: 'Карточка связей', kind: 'where-used',
            usageKind: kind === 'doc' ? 'doc' : 'file',
            usageId: kind === 'doc' ? (f.refId || f.id) : f.id,
          },
        ],
      },
    ),
  };
}
