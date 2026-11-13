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

- [ ] A (оболочка): `runConnect`, `runProgram` и тестовые программы,
      `runSaveFile`; набор на всех языках (TypeScript, C, C++, Rust, Go, C#)
      через движок Studio и сверка пределов с Flux
- [ ] B (окно): окна программы, подключения и согласие, вторая программа в
      тестовой базе, сохранение файла, «не отвечает»; набор интерфейса
- [ ] приёмка, документы (`studio.md`, `modules.md`, `module-api.md`,
      `studio-next.md`), CI на итоговой голове

## На чём остановился

Заведены ветка, файл хода и черновой PR; исполнители A и B запущены.
