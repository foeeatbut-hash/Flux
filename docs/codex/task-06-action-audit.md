# Задание 06 — карта действий и проверок

Карта вызовов для PR. Она фиксирует текущие маршруты по исходникам; статус проверки указан по фактическому доступу этой среды; UI без Chromium не выполнен, Windows-only проверки ожидают CI/Windows.

## Канал Проводника Windows

Обычный renderer вызывает `windowsFilesRequest` из `src/lib/windowsFiles.ts`, который передаёт клонируемый запрос через `window.electron.windowsFiles.invoke`. Preload отправляет его в `windows-files:invoke`. `electron/filesystem/ipc.ts` проверяет доверие/права и либо выполняет прямой case через `WindowsFilesService`, либо передаёт action в `ExplorerBridge`; последний направляет оболочечные операции в `ShellCommands` и `NativeShellHost` (Windows PowerShell). В таблицах `service` означает файловую службу; `native` — PowerShell-помощник Windows.

### Проводник: меню файла, двойной щелчок и свойства

| Действие | Renderer → запрос | IPC → служба / native | Проверка |
|---|---|---|---|
| Открыть папку | двойной щелчок или меню → переход на дочернее место | Роутер Flux; WindowsFiles не вызывается | UI не выполнен (нет Chromium) |
| Открыть файл | двойной щелчок или «Открыть» → внутренний маршрут; для особого типа возможен `open` | `windows-files:invoke` → `service.open` → Electron `shell.openPath` | UI не выполнен (нет Chromium); внешнее приложение ожидает CI/Windows |
| Открыть с помощью | меню → `openWithList`, затем выбранный handler → `openWith` | `ExplorerBridge` → `ShellCommands` → native `open-with-list` / `open-with` | Windows-only: ожидает CI/Windows; IPC fake-helper не заменяет платформенный прогон |
| Копировать / вырезать | меню или toolbar → `ops.copy` / `ops.cut`; действие складывает refs в буфер Flux | Вставка сначала `list` и проверка `fileHash`, затем `copy` / `move` или `replaceCopy` через service; диалог разрешает конфликты | UI не выполнен (нет Chromium); Windows-only часть ожидает CI/Windows |
| Переименовать | меню, toolbar или F2 → `rename` | Прямой IPC case → `service.rename` | UI не выполнен (нет Chromium); bridge harness проверен отдельно |
| Копировать как путь | меню или Ctrl+Shift+C → `copyPath` | Прямой IPC case → `service.filename`, Electron `clipboard.writeText` | UI не выполнен (нет Chromium) |
| Привязать папку к проекту | меню → `ProjectFolderBindingDialog`; подготовка ключей → `locationKeys` | `ExplorerBridge` → хеши расположения; сохранение привязки через проектный API | UI не выполнен; API regression не запускалась |
| Открыть в новой вкладке | меню → `tabs.open` | Только renderer, без файлового IPC | UI не выполнен (нет Chromium) |
| Закрепить в быстром доступе | меню → `quickAccessPin` | `ExplorerBridge` → `ShellCommands.pin` → native `quick-pin` | Windows-only: ожидает CI/Windows; IPC fake-helper не заменяет платформенный прогон |
| Опубликовать черновик | меню → `publishPlan`, затем подтверждение → `publishDraft` или `publishDraftTree` | План в `ExplorerBridge`; применение — прямой case → `service.publishDraft*` | UI не выполнен; API regression не запускалась; Windows destination ожидает CI/Windows |
| Сжать в ZIP | меню → диалог, затем `archive` | Прямой IPC case → `createArchive`/файловая служба; упакованная Windows-сборка использует bundled `7z.exe` | UI не выполнен (нет Chromium); bundled 7-Zip ожидает CI/Windows |
| Удалить | меню или toolbar → `fileHash` (файл), затем `trash` | Прямой IPC case → `service.trash`; черновик помечается в состоянии Flux, Windows-файл отправляется через Electron `shell.trashItem` | UI не выполнен (нет Chromium); Windows Корзина ожидает CI/Windows |
| Свойства | меню, toolbar или Alt+Enter → `stat`, открытие окна → `metadata` и `systemProperties` | `stat`/`metadata` через service; `systemProperties` → `ExplorerBridge` → `ShellCommands` → native helper | UI не выполнен (нет Chromium); systemProperties ожидает CI/Windows |
| Показать дополнительные параметры | меню → `shellMenu`; выбор → `shellMenuInvoke`; закрытие → `shellMenuClose` | `ExplorerBridge` → `ShellCommands` → native `menu-open`, `menu-invoke`, `menu-close` | Windows-only: ожидает CI/Windows; UI regression гонки invoke/close не выполнен без Chromium |

### Проводник: фон, toolbar и клавиши

| Поверхность / действие | Renderer → запрос | IPC → служба / native | Проверка |
|---|---|---|---|
| Фон: «Просмотреть», toolbar: sort/view/pane/toggles | смена раскладки, сортировки, группировки, preview/details, checkbox/extensions/hidden | Состояние интерфейса; сохранение вида — `viewStateGet`/`viewStateSet` в `ExplorerBridge` → `ViewStateStore` | UI не выполнен (нет Chromium); bridge harness проверен отдельно |
| Фон: «Обновить» | перезагрузка папки и Places | `list`/загрузка каталога через `WindowsFilesService` | UI не выполнен (нет Chromium) |
| Фон: создать | `panel.menuItem()` → общая панель создания | `createDraft` / `createDraftFolder` или публикация в Windows через соответствующие IPC cases и service | UI не выполнен; API regression не запускалась |
| Фон: «Копировать свойства Flux» | переключает `carryMeta` для следующих операций вставки | При вставке передаётся в `copy`/`replaceCopy`; service сохраняет метаданные Flux | UI не выполнен; API regression не запускалась |
| Фон / toolbar: «Вставить», toolbar: вырезать/копировать | `ops.paste/cut/copy`; разрешение конфликтов показывается до применения | `list`, `fileHash`, `copy`/`move`/`replaceCopy` через service | UI не выполнен (нет Chromium) |
| Toolbar: общий доступ | открывает `FileShareDialog` для одного личного объекта | Сервис общего доступа приложения; не WindowsFiles IPC | UI не выполнен; API regression не запускалась |
| Toolbar: отменить / повторить | `undo` / `redo` | `ExplorerBridge` → журнал `WindowsFilesService` | Bridge harness проверен отдельно; UI не выполнен |
| Фон: «Открыть Корзину» | открывает `RecyclePane`, загружает `recycleBin` | `ExplorerBridge` → `ShellCommands` → native `bin-list`; при неподдерживаемой Windows есть системный fallback | Windows-only: ожидает CI/Windows |
| Корзина: восстановить / удалить / очистить | `recycleBinRestore`, `recycleBinPurge`, `recycleBinEmpty` | `ExplorerBridge` → native `bin-restore`, `bin-purge`, `bin-empty` | Windows-only: ожидает CI/Windows |
| Enter | вызывает тот же `openEntry`, что двойной щелчок | Папка/обычный файл — маршрут Flux; special item — `open` service | UI не выполнен (нет Chromium) |
| F2 | переименование выбранного элемента | `rename` → `service.rename` | UI не выполнен (нет Chromium) |
| Delete / Shift+Delete | `ops.trash(selection, shift)` | `trash` или `permanentDelete` → service | UI не выполнен (нет Chromium); реальная Windows Корзина — Windows-only |
| Ctrl+C / Ctrl+X / Ctrl+V | Flux clipboard refs через `ops.copy/cut/paste` | При вставке `list`, `fileHash`, `copy`/`move`/`replaceCopy` → service | UI не выполнен (нет Chromium) |

## Рабочий стол Windows (`src/components/desktop/WindowsDesktop.tsx`)

Файлы Flux на зеркальном рабочем столе используют `windowsFilesRequest`; системные ярлыки Windows без file ref идут через отдельный `desktopShell` bridge. Координаты/масштаб значков хранятся локально в `localStorage`.

| Действие | Renderer → запрос | IPC → служба / native | Проверка |
|---|---|---|---|
| Двойной щелчок / меню «Открыть в Flux» | папка/файл → Flux route; shortcut с file ref — также route | Обычно без WindowsFiles IPC; системный ярлык без file ref → `desktopShell.open` | UI не выполнен (нет Chromium) |
| «Открыть в Windows» | `open` с ref | Прямой IPC case → `service.open` → Electron `shell.openPath` | Windows-only: ожидает CI/Windows |
| «Показать в Проводнике» | `reveal` с ref | Прямой IPC case → `service.reveal` → Electron `shell.showItemInFolder` | Windows-only: ожидает CI/Windows |
| «Свойства файла» | `metadata`, затем переход к Properties в Проводнике | Прямой IPC → `service.metadata`; окно свойств читает `stat`, `metadata`, `systemProperties` | UI не выполнен (нет Chromium); systemProperties — Windows-only |
| Опубликовать черновик / дерево | `publishDraft` / `publishDraftTree` | Прямой IPC case → `service.publishDraft*` | UI не выполнен; API regression не запускалась; Windows destination ожидает CI/Windows |
| Общий доступ… | открывает `FileShareDialog` | Сервис общего доступа приложения | UI не выполнен; API regression не запускалась |
| Удалить / «В Корзину Windows» | подтверждение, затем `trash` | Прямой IPC → `service.trash` → Electron `shell.trashItem`; черновик остаётся в корзине Flux | Windows-only: ожидает CI/Windows |
| Правый клик по системному ярлыку | `desktopShell.open` | Отдельный `desktopShell` IPC/native shell path, вне `windowsFiles` | Windows-only: ожидает CI/Windows |
| Фон: масштаб, сортировка, перетаскивание | меняет iconScale/sort/cells | Renderer/localStorage; без файлового IPC | UI не выполнен (нет Chromium) |
| Фон: обновить | `roots` и `list` через refresh | Прямые IPC cases → `WindowsFilesService` | UI не выполнен (нет Chromium) |
| Фон: создать файл/папку | общая панель создания → `createDraft`/`createDraftFolder` | Прямые IPC cases → `WindowsFilesService` | UI не выполнен; API regression не запускалась |
| Фон: параметры экрана / персонализация | переход к разделам Settings | Только renderer navigation | UI не выполнен (нет Chromium) |
| Enter / ContextMenu / Shift+F10 | на элементе: open / открыть контекстное меню; корневой handler: Ctrl+A выбирает всё, Escape очищает выбор | Открытие следует строкам выше; выбор и меню локальны | UI не выполнен (нет Chromium) |
| Delete / F2 / Ctrl+C/X/V | В `WindowsDesktop` эти клавиши не связаны с файловыми операциями | Нет запроса | UI не выполнен; текущий код не связывает эти клавиши с файловыми действиями, решение владельца остаётся открытым |

## Рабочий стол Flux (`src/components/Desktop.tsx`, браузерный fallback)

Это проектный стол, а не зеркало рабочего стола Windows. Его файлы/папки хранятся в данных Flux, поэтому действия не проходят через `windowsFiles`.

| Действие | Renderer → запрос | Дальше | Проверка |
|---|---|---|---|
| Двойной щелчок / меню «Открыть» | `openItem` → открыть папку, файл или группу | Навигация Flux/editor; для сопоставления Windows — `openInWindowsSaid` | UI не выполнен (нет Chromium) |
| Переименовать / F2 | `rename` из меню или `deskAction('rename')` | Операция проектного стола/хранилища Flux | UI не выполнен; API regression не запускалась |
| Убрать со стола / Delete | `doRemove` / `deskAction('remove')` | Подтверждение и операция проектного стола Flux | UI не выполнен; API regression не запускалась |
| Выгрузить в Windows / открыть в Windows | `exportItem` / `openInWindowsSaid` | Экспорт через файловые сервисы Flux; не WindowsFiles bridge | Windows-only: ожидает CI/Windows |
| Положить/убрать с общего стола; карточка связей; свойства | `doShare`, `openWhere`, `setProps` | API/renderer Flux | UI не выполнен; API regression не запускалась |
| Фон: создать / добавить файл | Create menu; file picker and `takeFiles` | Flux project API/upload | UI не выполнен; API regression не запускалась |
| Фон: вид / сортировка / обновить / открыть Проводник | локальный layout + `load(projectId)`; переход в `/explorer` | Renderer и API стола; переход к WindowsFiles — только при открытии Проводника | UI не выполнен (нет Chromium) |
| Enter / Alt+Enter / Ctrl+A / Escape | `deskAction`: открыть, свойства, выбрать всё, очистить выбор | Renderer/Flux API; без `windowsFiles` | UI не выполнен (нет Chromium) |
| Ctrl+C / Ctrl+X / Ctrl+V | Клавиши не реализованы в `deskAction` | Нет запроса | UI не выполнен; решение владельца по этим клавишам остаётся открытым |

## Финальные проверки после переноса Electron helper

После перемещения preload helper в `scripts/fixtures/windows-files-electron-main.ts` финальные проверки прошли: `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p .` (код завершения 0; лог `/tmp/flux06-final-tsc.log`) и `node --import tsx scripts/test-architecture.ts` (все проверки пройдены; лог `/tmp/flux06-final-architecture.log`).

## Фактические проверки и границы

**PASS в текущем цикле:**

- `npx tsc --noEmit -p .`;
- `node --import tsx scripts/test-architecture.ts`;
- `node --import tsx scripts/test-diagnostics.ts`;
- `node --import tsx scripts/test-windows-files-bridge.ts`;
- `node --import tsx scripts/test-explorer-shell.ts`;
- `node --import tsx scripts/test-file-sharing-sync.ts`;
- `node --import tsx scripts/test-windows-files.ts` — 239 сценариев;
- `node --import tsx scripts/test-explorer-operations.ts` — 9 успешно, 0 ошибок;
- `node --import tsx scripts/test-explorer-tabs.ts`;
- `node --import tsx scripts/test-explorer-view-model.ts` — 15 проверок;
- `node --import tsx scripts/test-explorer-native-operations.ts` — 26 проверок.

Полные логи пяти последних запусков находятся в `/tmp/flux06-final-windows-files.log`, `/tmp/flux06-final-explorer-operations.log`, `/tmp/flux06-final-explorer-tabs.log`, `/tmp/flux06-final-explorer-view-model.log` и `/tmp/flux06-final-explorer-native-operations.log`. Результаты первых шести PASS передал руководитель реализации.

**Не выполнено / ожидает среды:**

- `test-icons-shell-ui`, `test-explorer-operation-ui`, `test-explorer-contents-ui`, `test-explorer-folder-errors-ui`, `test-explorer-nav-ui` и `test-explorer-shell-ui` запускались после успешного старта Vite на `http://127.0.0.1:5173`, но Chromium не стартовал: в среде отсутствуют `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` и `/usr/bin/chromium`. Поэтому UI-проверки не выполнены. `test-windows-explorer-ui` ранее также завершился из-за отсутствия Chromium; повторно не запускался.
- `test-explorer-open-live` остановился на проверке credentials: не заданы `FLUX_USER`/`FLUX_PASS`; live API действия не выполнялись.
- Локальная попытка запустить Electron harness была остановлена до assertions из-за отсутствующего X server (`xvfb-run`/`Xvfb` нет, `$DISPLAY` пустой). В PR 115 CI на SHA `9d86ecccebf0a1610b51333daf86ed71192c6219` реальный Windows шаг `Реальный Electron preload и файловый IPC на временной папке` и шаг Explorer на настоящей NTFS/Windows Shell завершились успешно.
- PowerShell/native shell menu, системные свойства, quick access, Windows Recycle Bin и реальные Windows open/reveal/ZIP операции ожидают Windows CI. Fake host/IPC и временная файловая система не подтверждают поведение Windows API.

## Обязательные границы доказательства

- `scripts/test-windows-files-bridge.ts` проверяет bridge/service на подставном Node helper и статически проверяет контракт preload; он не открывает настоящее sandboxed окно Electron.
- `scripts/test-windows-files.ts` проходит Linux-сценарии файлового сервиса. `scripts/test-explorer-native-operations.ts` использует временную файловую систему, но подменяет Win-native метаданные и действия корзины.
- В таблицах `UI не выполнен` и `ожидает CI/Windows` — ограничения текущей среды, а не подтверждение исправности или отказа действия.
