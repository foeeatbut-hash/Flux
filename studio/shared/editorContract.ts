/**
 * Договор раздела «Редактор»: что оболочка Studio передаёт редактору и что получает обратно.
 *
 * `draft.files` — текстовые файлы проекта (путь → содержимое; manifest.json, form.json, logic/…, examples/…);
 * двоичные (.wasm, снимки) в нём не передаются, их имена — в `binary`. Редактор вызывает `onChange` с
 * изменёнными файлами; оболочка сохраняет их в черновик (те же правила путей, что у пакета) и передаёт
 * редактору обновлённый `draft`. Проверка перед отправкой и запуск читают тот же черновик.
 */
export interface EditorDraft { files: Record<string, string>; binary: string[] }
export interface EditorProps {
  moduleId: string;
  draft: EditorDraft;
  /** Сохраняет изменённые файлы; ответ — текст ошибки сохранения или пустая строка */
  onChange: (changed: Record<string, string>) => Promise<string>;
}
