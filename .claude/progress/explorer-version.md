# Строка 4: сверка в Проводнике и на рабочем столе; кнопка «Создать»

Решения руководителя (владелец не на связи, просил делать всё подряд).

## Что входит
Проводник пишет файлы Windows через мост Electron, а записи FileNode общей
базы правят рабочий стол Flux и перетаскивание файлов. Сверка ставится на
маршруты `server/routes/explorer.ts` и `server/routes/desktop.ts`:

| Маршрут | Что делаем |
|---|---|
| PATCH /api/files/:id (имя) | `guardedWrite`, `expectedVersion` в теле; 409 VERSION_CONFLICT с `current`; нет — 404 RECORD_GONE |
| DELETE /api/files/:id (в корзину — это правка) | `guardedWrite`, `?expectedVersion=`; уже в корзине/нет — как у тега |
| POST /api/files/:id/restore | `guardedWrite`, `expectedVersion` в теле |
| POST /api/desktop/move (файл) | `guardedWrite`, `expectedVersion` в теле |
| POST /api/files/copy — ветка замены существующего (update) | сверка с собственным чтением в транзакции (`guardedWrite` без версии клиента) |
| POST /api/files, POST /api/folders, POST /api/desktop/folder | создание, сверять нечего |
| Папки (PATCH/DELETE/restore /api/folders/:id, перенос папки) | у Folder нет колонки version и он не входит в 12 моделей — не трогаем, записано в остаток |
| DELETE /api/projects/:id/trash | очистка корзины, клиента нет — не трогаем |

Остаток части 4 (не в этом PR): копии и версии Office, чат, архивы, общий
доступ, `office:ipc` — у них своя сверка по sha/hash или её нет; папки.

Открытая запись у файла не вводится: у открытого в редакторе файла своя
блокировка, корзина обратима.

Слово словаря: `file` (файл) — `NOUNS`, `NOUN_OF_MODEL.FileNode`.

## Клиент
`src/services/dataService.ts` (renameNode, trashNode, moveNodes/desktop move) и
`desktopStore.ts` шлют `expectedVersion` для файлов; отказ — окном с
`ConflictNotice` («поле: было → стало»: имя, папка, в корзине), список
перечитывается. Правила — `src/components/desktop/changeRules.ts`.

## Кнопка «Создать»
В панели команд Проводника (`CommandBar.tsx`) — кнопка «Создать ▾» с теми же
пунктами, что «Создать ▸» в меню пустого места (`CreatePanel.tsx`); меню правой
кнопкой остаётся.

## Чем доказывается
- `scripts/test-file-version-routes.ts` (настоящие маршруты, SQLite): мутации — убрать сверку у имени, корзины, восстановления, переноса.
- `scripts/test-desktop-version-ui.ts` (настоящая служба, двое, обе темы): мутации — не слать версию; не показывать перечень.
- Кнопка: дополнение `scripts/test-windows-explorer-ui.ts` или свой набор; мутация — убрать кнопку.

## Ход
- [ ] D: сервер файлов + набор маршрутов
- [ ] E: клиент рабочего стола + набор интерфейса
- [ ] F: кнопка «Создать» + проверка
