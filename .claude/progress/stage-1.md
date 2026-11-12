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
- 12.11: `ci-flaky-2` принят по коду (bc16935d, f61f4fc2, 00a73f89). В контейнере проверены только test-metrics и tsc. НЕ запускалось: office-native (Backspace, openPanel), полный Flux на Windows (FLUX_LOAD_ATTEMPT/OK), вид кнопки окна приложения в Electron (значения в пикселях те же: 4/192/176). Подтверждение — CI на PR 167 (job office-native, modules-windows, windows-shell) и глаз владельца на Windows.
- 12.11: CI office-native упал на f3080d11 (run 43271612025, job 131369327011) — третья, новая нестабильность, не Backspace и не openPanel: `scripts/test-office-explorer-live.ts:652`, «ожидаемые 409 ограничены сценарием и восстановление источника прошло» — ожидался 1 ответ 409 на POST /api/project-data/office/query, наблюдено 0, затем кнопка «Обновить выборку» осталась disabled 30 с. Коммит меняет только документы и test-modules-restart-ui → не от этого PR. Разобрать отдельным заданием (первая причина: почему 409 не пришёл — гонка сценария с автосохранением/состоянием источника?), когда освободится исполнитель.
