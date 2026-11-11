/**
 * Договор раздела «Редактор» с оболочкой Studio — тот же, что studio/shared/editorContract.ts в ветке
 * основы разработчика (4б-1). Типы повторены здесь, чтобы редакторы собирались и проверялись
 * отдельно от неё; структурно они совпадают, и после слияния веток оболочка подключает
 * `studio-editors` без правок.
 *
 * `draft.files` — текстовые файлы проекта (путь → содержимое), `binary` — имена остальных.
 * `onChange` получает только изменённые файлы; ответ — текст ошибки сохранения или пустая строка.
 */
export interface EditorDraft { files: Record<string, string>; binary: string[] }
export interface EditorProps {
  moduleId: string;
  draft: EditorDraft;
  onChange: (changed: Record<string, string>) => Promise<string>;
}
