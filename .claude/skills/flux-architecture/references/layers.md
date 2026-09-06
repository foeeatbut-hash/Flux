# Карта кода Flux

Справочник «где что лежит», чтобы не искать заново. Проверять при расхождении:
структура меняется, эта страница — нет.

## Клиент, `src/`

| Папка | Что там |
|---|---|
| `App.tsx`, `main.tsx` | вход, роутер, корневая граница ошибок, перехват консоли в Журнал |
| `workspace/sections.tsx` | **реестр разделов**: путь → экран, значок, режим прокрутки. Единственное место, где раздел «появляется» в программе |
| `components/WindowsLayer.tsx` | рабочий стол: окна разделов, их геометрия, keep-alive и замороженный роутер для скрытых окон |
| `screens/` | экраны разделов и несколько крупных компонентов, оказавшихся здесь исторически |
| `components/` | общий интерфейс: `Layout`, `Taskbar`, `StartMenu`, `Desktop`, `ModalProvider`, `ToastProvider`, `SocketProvider`, мастера импорта, `SectionErrorBoundary` |
| `store/` | zustand: `store` (пользователь, проект), `chatStore`, `workspaceStore` (память адресов открытых окон), `windowStore`, `notificationStore`, `logStore`, `toastStore`, `modalStore`, `shareStore`, `assistantStore` |
| `services/dataService.ts` | все запросы к серверу |
| `capture/` | захват с экрана: `recognize`, `vocab`, `plan`, `fields` |
| `import/` | импорт документов: `recognize`, `extractors`, `ocr`, `valueGrammar`, `dictionary`, `learn`, воркер |
| `assistant/` | встроенный помощник: `knowledge`, `nlp`, `sections`, `tours` — локально, без сети |
| `lib/` | мелкие независимые утилиты: права, роли, склонения, лицензия, ссылки |
| `robot/` | маскот: `rig`, `poses`, `player`, `scenes`. Файлы с `__` — черновики, в сборку не входят |
| `config/env.ts` | адрес сервера и прочее окружение |

## Разделы (из `SECTIONS`)

`/` Главная · `/projects` Проекты · `/registry` Теги · `/equipment` Оборудование ·
`/directory` Справочник · `/management` Менеджмент · `/explorer` Проводник ·
`/constructor` Конструктор · `/notes` Блокнот · `/chat` Чат · `/generator` Генератор ·
`/settings` Настройки · `/logs` Журнал · `/users` Сотрудники (только админ).

Отдельно от рабочего стола живут `Login`, `LicenseGate`, `StickerWindow`,
`CapturePult` — у них свои окна или свой этап входа.

Файлы в `screens/`, которых нет в `SECTIONS`: `TitlePanel`, `TitleTemplateEditor`,
`TextDocEditor`, `VdrPanel`, `titleTemplate.ts`. Это компоненты, а не разделы.

## Сервер

| Файл | Что делает |
|---|---|
| `server.ts` | Express + socket.io, почти все маршруты. Большой; новое — в `server/routes/` |
| `server/routes/` | `constructor` (формулы и своды), `notes`, `logs`, `settings`, `vdr` |
| `server/normalize.ts` | числа, единицы, ключи параметров — общий словарь нормализации |
| `server/equipmentParser.ts`, `equipmentImport.ts`, `equipmentPlan.ts` | разбор бланков и **план** импорта оборудования |
| `server/excelParser.ts`, `specUtils.ts` | таблицы и спецификации |
| `server/schema-sync.ts`, `backup.ts` | схема БД и резервные копии |
| `server/context.ts` | контекст запроса (пользователь, проект) |

Prisma: три схемы — `prisma/schema.prisma` (SQLite), `schema.postgresql.prisma`,
`schema.mariadb.prisma`. Генерировать нужно все, иначе сборка падает.

## Electron

`electron/main.ts` — окна, обновление, IPC; `capture.ts` — пульт захвата, трей,
горячая клавиша, слежение за буфером; `license.ts` — проверка лицензии;
`preload.ts` — мост в окно; `trayIcon.ts` — значок трея строкой base64 (в сборку
попадает только `dist`, `dist-electron` и `package.json`, поэтому не файлом).

## Проверки

`scripts/test-*.ts`, запуск `npx tsx scripts/test-<имя>.ts`:
`architecture`, `capture`, `constructor-fn`, `blank-parser`, `normalize`,
`doc-import`, `nlp`, `assistant`.
