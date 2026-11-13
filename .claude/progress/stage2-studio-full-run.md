# Этап 2, пункт б): полный запуск в Studio на всех языках, кроме Python

Задание: `docs/roadmap/studio-next.md`, «Решение владельца (12 ноября 2026)»,
пункт 1. Ветка `claude/optimistic-maxwell-bxr8eo`, старт от `origin/main`
9a7bbc6 (PR 169). Пункт а) — `.claude/progress/stage2-dev-run.md` (влит PR 168).

## Что уже было в запуске Studio (до этой ветки)

Форма и страница в том же кадре и мосте (`modules/bridge.ts`), TypeScript и
WebAssembly, тестовая база, диалоги (`RunDialog`), `flux.openFile`,
`flux.net.fetch` (`runNet`), снимки тем. Только в журнал: окна
(`windows.open`, `setTitle`, `setUnsaved`), обмен между окнами, сохранение
файла. Нет вовсе: подключения (`connect`), вторая программа для
`flux.programs.call` (ответ `NOT_INSTALLED`), «Программа не отвечает».

## Устройство (решение руководителя)

- **Договор действий оболочки** (главный процесс Studio ↔ окно), общий для
  обоих исполнителей:
  - `runConnect { connection, call }` → `{ ok: true, data } | { ok: false, code }`
    — тот же код, что во Flux (`electron/moduleConnections.ts`, `moduleCom.ts`,
    `modules/connections/`): объявление из манифеста запущенного проекта, те же
    пределы. Решение человека спрашивает окно Studio (`runConnectAsk` —
    событие/ответ), хранится в памяти до закрытия Studio; политики
    администратора в Studio нет — строка в журнале запуска.
  - `runProgram { call }` → `ProgramReply` — вторая программа из своих
    черновиков, «установленная» в тестовую базу (`testPrograms`,
    `testProgramInstall { id }`, `testProgramRemove { id }`); проверки и
    пределы — код `modules/programs/` и `electron/moduleProgramCalls.ts`;
    метод на Python — отказ `FAILED` со строкой «Python — во Flux».
  - `runSaveFile { name, mime, bytes }` → `'saved' | 'cancelled'` — системный
    диалог сохранения, как во Flux.
- **Окна** (`flux.windows.open`, заголовок, размер, несохранённое, обмен,
  параметры, предел числа окон, «не отвечает» 30 с) — настоящие окна программы
  внутри запуска Studio: у каждого свой кадр и мост, оформление и поведение
  как у окна Flux.
- Запись в данные Flux невозможна: мост тот же, чтение — только тестовая база.

## Шаги

- [x] A (оболочка): `runConnect`, `runProgram` и тестовые программы,
      `runSaveFile`; набор на всех языках (TypeScript, C, C++, Rust, Go, C#)
      через движок Studio и сверка пределов с Flux
- [x] B (окно): окна программы, подключения и согласие, вторая программа в
      тестовой базе, сохранение файла, «не отвечает»; набор интерфейса
      `scripts/test-studio-run-ui.ts` (84 проверки, обе темы; действия A в стенде — заглушка по `studio/shared/runActions.ts`)
- [ ] приёмка, документы (`studio.md`, `modules.md`, `module-api.md`,
      `studio-next.md`), CI на итоговой голове

## На чём остановился

Заведены ветка, файл хода и черновой PR; исполнители A и B запущены.

## Исполнитель A: сделано/открыто

### Точная форма действий оболочки (для исполнителя B; типы — `studio/shared/runActions.ts`)

Все действия — через `window.studio.call(action, args)`, ответ `{ ok, value, error }`. Новые имена добавлены в `DEVELOPER_ACTIONS`.

| Действие | Аргументы | `value` |
|---|---|---|
| `runConnect` | `{ connection: string, call: ConnectCall }` (вызов как по мосту: `http`, `ws-*`, `com-*`) | `{ ok: true, data } \| { ok: false, code, line? }`; коды `DENIED NOT_ALLOWED LIMIT TIMEOUT TARGET UNAVAILABLE FAILED`, `ASK` окну не приходит |
| `runConnectAnswer` | `{ id, decision: 'always'\|'once'\|'never' }` | `{ answered: boolean }` (false — вопрос уже закрыт) |
| `runStop` | `{}` | `{ stopped: true }` — закрывает подключения и объекты COM запуска, снимает вопросы; после него `run*` отказывают, пока не будет нового `runStart` |
| `testPrograms` | `{}` | `TestProgramRow[]`: `{ id, name, version, language, exports: [{method, does}], installed }` — все свои черновики |
| `testProgramInstall` | `{ id }` | `TestProgramRow[]` (обновлённый список); отказ словами, если черновик не собирается |
| `testProgramRemove` | `{ id }` | `TestProgramRow[]` |
| `runProgram` | `{ call: { program, method, data? } }` | `ProgramReply` (`{ ok: true, data } \| { ok: false, code }`) и необязательная `line` — строка для журнала запуска |
| `runSaveFile` | `{ name, mime, bytes: Uint8Array }` | `'saved' \| 'cancelled'`; недопустимое имя — отказ словами |

События окну: `window.studio.onRun(fn)` (канал `studio:run`, добавлен в предзагрузку), `fn(event: RunEvent)`:
- `{ kind: 'connectAsk', id, ask: GrantAsk }` — вопрос о подключении (тексты из манифеста запущенного проекта: `app`, `does`, `access`, `technical`, `kind`, `moduleName`, `author`); окно показывает три ответа и вызывает `runConnectAnswer`;
- `{ kind: 'connectAskClose', id }` — снять диалог (запуск закрыт, время ожидания 5 минут вышло, ответ уже дан).
`runConnect` не возвращается, пока человек не ответил (или вопрос не снят: тогда `NOT_ALLOWED`, решение не запоминается). Решение хранится в памяти оболочки до закрытия Studio и привязано к тексту разрешения; «только сейчас» живёт до `runStop`/нового запуска.

### Сделано (A), шаг 2

- Действия оболочки: `studio/shell/runHost.ts` (входная точка), `runConnections.ts`, `runPrograms.ts`, `runSaveFile.ts`, `runJournal.ts`; склейка в `developer.ts` (`stopRun`, `buildProgram` — общая сборка для «Запустить во Flux» и «установить»).
- Общее с Flux: `ModuleConnections`/`ModuleProgramCalls` используются как есть (в их `deps` журнал сужен до `Pick<ModuleJournal,'add'>`, `ModuleGrants` принимает `file = null` — решения только в памяти); последовательность вызывающей стороны вынесена в `modules/programs/caller.ts` (окно Flux берёт её оттуда, поведение то же; мутанты `test-modules-programs` переведены на новый файл).
- Движок Studio: пределы в `COMPUTE_LIMITS` (время — `LIMITS.timeoutMs`), предел файла логики TypeScript как у Flux, логика TypeScript исполняется в пустом контексте `vm` (без process, require, fetch, import()).
- Набор `scripts/test-studio-run-full.ts` (+ `scripts/fixtures/studioRunBatteries.ts`), в `verification/manifests/studio.json` и `build-studio.yml`.
- Добавлено к договору: у отказов `runConnect` и `runProgram` есть необязательная `line` — строка только для журнала запуска (в программу её передавать нельзя).
- Открыто: настоящий COM (PowerShell) и системные диалоги Electron — только Windows; контрольные примеры вызываемой программы в Studio не гоняются (это кнопка «Проверить»); TypeScript в форме считает окно программы, а не оболочка.

## Исполнитель B: сделано/открыто

- Окна: `studio/renderer/sections/run/` (`ProgramWindow`, `model`, `RunConnectPrompt`, `TestPrograms`), `Run.tsx` собирает общий хост. Тексты запроса подключения общие с Flux: `src/components/modules/connectionPromptText.ts`.
- Порог «не отвечает» в окне можно сократить адресом `?hang=<мс>` (не меньше 1000) — только для проверок.
- От A: набор B гоняет действия A как заглушку стенда; нужна сверка на настоящей службе (`runConnect` с событием `onRun`, `testPrograms*`, `runSaveFile`) и на Windows.
