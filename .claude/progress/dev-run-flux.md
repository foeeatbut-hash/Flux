# Задача dev-run-flux: сторона Flux для «Запустить во Flux» из Studio

Ревизия старта a6fc5056 (origin/claude/lucid-curie-ffxaso). Рабочая ветка worktree:
`worktree-agent-a88d9f19f613aeb68`; после каждого шага — rebase и push в
`claude/lucid-curie-ffxaso` (без force). Порты: сервер 3411, Vite 5411.
Чужие файлы: всё в `studio/`; `modules/trust/devRun.ts` и `claims.ts` не менять.
Договор: `modules/trust/devRun.ts`, `.claude/progress/stage2-dev-run.md`,
`docs/roadmap/studio-next.md` (решение 12 ноября, п. 2).

## Шаги

- [x] 1. Набор `scripts/test-modules-dev-run.ts` (49 проверок, реестр `modules-dev-run`); мутации verifyDevRun: 24 из 24 пойманы
- [x] 2. Главный процесс: `electron/moduleDevRuns.ts` (чтение папки, проверка, память, согласие, «Убрать»), `moduleDevRunsIpc.ts` (`modules:devRuns/devAccept/devRemove`, событие `modules:devChanged`), встройка в `modules.ts` (overlay поверх кэша: base → runnable), `moduleGrants.ts` (отдельная область `dev:` для решений о подключениях, не пишется в файл). Набор `test-modules-dev-run-host.ts` (60 проверок, реестр `modules-dev-run-host`); мутации ModuleDevRuns/ModuleGrants: все пойманы
- [ ] 3. Окно Flux: «Пуск» (плашка), Библиотека Store («Из разработки»: карточки, причины отказа, «Убрать»), ModuleHost (плашка, согласие, остановка при истечении)
- [ ] 4. Набор на настоящем Electron (`test-modules-dev-run-native.ts`), tsc, `run-checks modules`, архитектурный, раздел в `03-programs/modules.md`

## Проверки «до» (a6fc5056)

`run-checks.ts modules`: 40 наборов, провалено 3 (restart-ui, store-ui, windows-ui: нет Chromium/FLUX_UI_URL — среда), пропущено 5 (native: нет DISPLAY). Это с моим набором step 1 (он проходит).

## Решения

- Решения о подключениях пакета разработки не смешиваются с выпуском: ключ `dev:<user>|<id>|<conn>`, только память.
- `modules:state` не включает пакеты разработки в `runnable` (иначе попадут в обращения/ошибки по программам), а даёт отдельный `dev`.
- Согласие: в памяти, ключ (человек, программа, хеш сборки).

## На чём остановился

Шаг 2 готов, коммит — ниже. Следующее: шаг 3.
