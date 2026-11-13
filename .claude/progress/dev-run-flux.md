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
- [x] 3. Окно Flux: «Пуск» («(разработка)»), Библиотека Store («Из разработки»: карточки, причины отказа, «Убрать», `StoreDevRuns.tsx`), ModuleHost (плашка-Chip, «Убрать», согласие `DevConsentDialog`, остановка при истечении); набор `test-modules-dev-run-ui.ts` (17 проверок, нужен свой Vite 5411 и FLUX_CHROME), снимки в обеих темах просмотрены
- [x] 4. Набор на Electron `test-modules-dev-run-native.ts` (41 проверка, xvfb), реестр, шаги CI (Windows-native в verify-modules, ui в verify-program-contracts), раздел в `03-programs/modules.md`; tsc 0, архитектурный зелёный, `run-checks modules` (с FLUX_UI_URL, без DISPLAY): 43 набора, 0 провалов; native под xvfb по одному: page-native 47, compute-native 43, connections-native 31, dev-run-native 41

## Проверки «до» (a6fc5056)

`run-checks.ts modules`: 40 наборов, провалено 3 (restart-ui, store-ui, windows-ui: нет Chromium/FLUX_UI_URL — среда), пропущено 5 (native: нет DISPLAY). Это с моим набором step 1 (он проходит).

## Решения

- Решения о подключениях пакета разработки не смешиваются с выпуском: ключ `dev:<user>|<id>|<conn>`, только память.
- `modules:state` не включает пакеты разработки в `runnable` (иначе попадут в обращения/ошибки по программам), а даёт отдельный `dev`.
- Согласие: в памяти, ключ (человек, программа, хеш сборки).

## На чём остановился

Все шаги готовы и запушены (последний ab3b04e8). CI Windows: dev-run-native зелёный; connections-native:201 (настоящий COM) падает через раз на одном и том же коде Flux (eceb0d7a, ab3b04e8 — провал; f7b95870, 2f16640b — зелёный); в моих правках гонки с COM нет (resolve делает дроссельный опрос папки обмена, без папок — пустой; ключ согласий у выпуска прежний).
