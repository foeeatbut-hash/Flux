# Этап 1 — всё, что осталось по плану (ветка claude/flux-stage-1-pjmxgt)

Задание владельца 12 ноября 2026; порядок — `docs/roadmap/studio-next.md`,
«Порядок работ». Ревизия старта: d3f0f597 (main после PR 166).
После каждого принятого шага — коммит, отметка здесь, push.

- [ ] 1. Находки ручной проверки владельца на Windows — на начало сессии не присланы
- [x] 2. Долги PR 165 (кроме 2г — не нужен)
  - [x] 2а. методы `flux.programs.call` на TypeScript (отказ в `modules/trust/execution.ts`)
  - [x] 2б. запрет администратором обращения к программам (образец — @internet/@lan)
  - [x] 2в. `test-modules-programs` на настоящих Pyodide и WebAssembly
  - [ ] 2г. WebSocket по полному адресу — только если нужен
- [x] 3. Хвосты рабочего окна Studio: [x] типы при сборке TypeScript; [x] пробный запуск владельца (файл, диалоги); [x] окно «Лицензии»
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
- 12.11: падение contracts (test-architecture: test-office-addon-native-live.ts 1209 > 1200) исправлено в 8c3fa356. CI на 8c3fa356 зелёный весь: contracts, office-native, modules-windows, windows-shell, security-db, remaining-api-fixture, «Проверки Studio», FluxStudio.exe. Значит, на Windows прошли правки ожиданий office-native, повтор loadURL и FLUX_REQUIRE_NO_SKIP (ни один обязательный набор не пропускался молча). Нестабильность «восстановление источника после 409» не повторилась и не разобрана.
- 13.11: оба исполнителя (`ts-exports`, `studio-owner-tails`) оборваны лимитом на середине и возобновлены сообщением; у обоих была непушенная работа в worktree (.claude/worktrees/agent-ae85e4cf… и agent-a0bb1acf…). Общий файл `studio/shell/developer.ts` — конфликт решать с сохранением обеих правок.
- 13.11: `ts-exports` принят (вершина 5b507e1c): третий исполнитель ModuleCompute, хост `flux-module://_compute/ts.html` с MODULE_CSP, `build/logic.js` в пакете, оба отказа сняты. Проверено: test-modules-ts-host в настоящем Chromium (46, 8 мутаций), test-modules-programs (111, 24 мутации), tsc. modules-windows на 5b507e1c упал — ошибка набора (CRLF на Windows, многострочный фрагмент мутации), исправлено в bee560f4, локально прогнано на CRLF-исходниках; подтверждение — CI. НЕ проверено: настоящий flux-module:// в Electron/Windows.
- 13.11: `studio-owner-tails` принят (e7f31a8c, 37ef8918, b50d0fb4): файл и диалоги в пробном запуске владельца (общий код studio/shell/programFile.ts, studio/renderer/work/programDialog.ts), «Лицензии» внутри окна разделов (старое окно и studio/owner/ui удалены). Руководитель сам прогнал test-studio-owner-console-ui на вершине: 416, снимки смотрел. НЕ проверено: системный выбор файла и родитель системных диалогов под настоящим Electron на Windows — глазами владельца.
- 13.11: в работе `program-policy` (2б + 2в, файл хода `.claude/progress/program-policy.md`, своя ветка worktree, пушит HEAD:ветка).
- Находка: путь Chromium в правилах был устаревший (chromium-1194, в образе 1243) — наборы *-ui у исполнителей могли молча пропускаться; правила исправлены. Тот же путь зашит в scripts/test-icons-shell-ui.ts, test-remaining-engineering-registry-ui.ts, test-design-live.ts, test-office-explorer-live.ts, walkthrough.ts, test-windows-file-office-sheets-native-live.ts, test-tag-canvas-live.ts — разобрать в пункте 5.
- Урок: исполнителю не давать переключаться на рабочую ветку в worktree (ветка общая — у основной копии «появляются» обратные изменения); пушить `HEAD:ветка` из своей.
- 13.11: падения remaining-api-fixture и contracts на b50d0fb4…561dc544 — одна причина: манифест identity-owner.json ссылался на удалённый studio/owner/ui/app.js; исправлено в a0a66890 (check:verification, check:coverage локально зелёные).
- 13.11: `program-policy` принят (561dc544, a124de0f, a3961c0a): запрет администратором `@program:<id>` (главный процесс, сервер, экран политики; подпись «Локальная сеть» исправлена), набор test-modules-programs-engines на настоящих Pyodide/WebAssembly/TypeScript в Chromium, наборы programs/permissions/engines включены в манифест и verify-modules.yml, 4 случая вызова в test-modules-compute-native. Руководитель сам прогнал на вершине: engines 28, programs 120. Исполнитель прогнал native-набор под Xvfb в контейнере (43) — Electron в контейнере ЕСТЬ. Ждёт Windows-CI. Не сделано: запрет и TIMEOUT в настоящем Electron.
- 2г (WebSocket по полному адресу) — не нужен ни одной программе, не делается; остаётся строкой в плане.
- В работе: `studio-typecheck` (шаг 1 запушен c831b035).
- 13.11: `studio-typecheck` принят (c831b035, daed884e): сверка типов настоящим компилятором в потоке ts-type-worker.cjs, strict, ошибки в «Проблемы», +5,2 МБ к сборке Studio. Руководитель прогнал test-studio-tsbuild на вершине: 82. НЕ проверено: поток из asarUnpack в упакованной Studio на Windows, время первой сверки на реальном ПК.
- 13.11: пункт 4 «как в GitHub» — устройство записано в studio-next.md («Очередь до выпуска», п. 2); исполнитель `studio-history` (файл хода `.claude/progress/studio-history.md`). В работе также `ci-flaky-3`.
