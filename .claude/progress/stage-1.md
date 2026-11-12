# Этап 1 — всё, что осталось по плану (ветка claude/flux-stage-1-pjmxgt)

Задание владельца 12 ноября 2026; порядок — `docs/roadmap/studio-next.md`,
«Порядок работ». Ревизия старта: d3f0f597 (main после PR 166).
После каждого принятого шага — коммит, отметка здесь, push.

- [ ] 1. Находки ручной проверки владельца на Windows — на начало сессии не присланы
- [ ] 2. Долги PR 165
  - [ ] 2а. методы `flux.programs.call` на TypeScript (отказ в `modules/trust/execution.ts`)
  - [ ] 2б. запрет администратором обращения к программам (образец — @internet/@lan)
  - [ ] 2в. `test-modules-programs` на настоящих Pyodide и WebAssembly
  - [ ] 2г. WebSocket по полному адресу — только если нужен
- [ ] 3. Хвосты рабочего окна Studio: типы при сборке TypeScript; пробный запуск владельца (файл, диалоги); окно «Лицензии»
- [ ] 4. Функции «как в GitHub»: история версий, сравнение, откат, замечания к строкам, список выпусков
- [ ] 5. Нестабильные проверки CI: office-native, полный Flux на Windows (FLUX_LOAD_*), test-modules-restart-ui, молча пропускающие себя наборы

## Ход
- 12.11: находок с Windows нет → начат пункт 2. Исполнители (worktree, пушат wip в эту ветку):
  `ts-exports` (2а, файл хода `.claude/progress/ts-exports.md`), `ci-flaky` (пункт 5, `.claude/progress/ci-flaky.md`).
  Возобновление: новый flux-executor «продолжи по файлу хода». 2б (политика администратора) — после приёмки 2а: общий файл `electron/moduleProgramCalls.ts`.
- 12.11: ответы владельца записаны в studio-next.md и offline-work.md (выпуск после офлайна; узкое доверие; вход перед программой без базы; 4 умолчания офлайна).
- 12.11: `ci-flaky` принят (b684c264, 207a4ed3, 1a77fb2f): стенд test-modules-restart-ui (ошибка теста — нет preamble React при HMR), ожидание снимка в test-modules-store-ui, пропуск набора виден и падает при FLUX_REQUIRE_NO_SKIP=1 (`docs/testing/skipped-suites.md`). НЕ проверено на Windows: verify-modules.yml с новой переменной может покраснеть — смотреть CI.
  Осталось по пункту 5 → исполнитель `ci-flaky-2`: Taskbar.tsx под правило test-metrics (размеры в общую меру), ожидания в office-native (Backspace в Word, origin кадра в openPanel), повтор loadURL в полном Flux на Windows. Причина chrome-error строками FLUX_LOAD_* ещё не получена — ждать следующего падения.
