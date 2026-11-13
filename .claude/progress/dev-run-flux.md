# Задача dev-run-flux: сторона Flux для «Запустить во Flux» из Studio

Ревизия старта a6fc5056 (origin/claude/lucid-curie-ffxaso). Рабочая ветка worktree:
`worktree-agent-a88d9f19f613aeb68`; после каждого шага — rebase и push в
`claude/lucid-curie-ffxaso` (без force). Порты: сервер 3411, Vite 5411.
Чужие файлы: всё в `studio/`; `modules/trust/devRun.ts` и `claims.ts` не менять.
Договор: `modules/trust/devRun.ts`, `.claude/progress/stage2-dev-run.md`,
`docs/roadmap/studio-next.md` (решение 12 ноября, п. 2).

## Шаги

- [x] 1. Набор `scripts/test-modules-dev-run.ts` (49 проверок, в реестре `modules-dev-run`); мутации: 24 из 24 пойманы
- [ ] 2. Главный процесс: `electron/moduleDevRuns.ts`, встройка в `electron/modules.ts`, IPC `modules:devRuns`/`devAccept`/`devRemove`
- [ ] 3. Окно Flux: список программ, плашка «Разработка — не выпущено», «Убрать», диалог согласия
- [ ] 4. Набор на настоящем Electron, tsc, `run-checks modules`, архитектурный, раздел в `03-programs/modules.md`

## Проверки «до»

`run-checks.ts modules` на a6fc5056 — см. ниже (заполняется).

## На чём остановился

Шаг 1 готов.
