# ts-exports — методы flux.programs.call на TypeScript

Задание руководителя (12 ноября 2026), часть «2а» файла хода `stage-1.md`. Ревизия старта dae160c0.
Ветка локальная worktree-agent-ae85e4cf1bf73c20f, push в `claude/flux-stage-1-pjmxgt` (fetch + rebase, без force).
Порт сервера 3210, Vite 5210 (не нужны, пока не дошло до UI).

Решения руководителя:
1. Третий исполнитель в ModuleCompute: логика TS как чистая функция JSON→JSON в изолированном хосте
   (`flux-module://_compute/…`, строгий CSP без сети), Worker на вызов, остановка по времени — terminate.
   Вход `{export, data}`, ответ `calc.out`, те же LIMITS и очередь. CSP без сети доказать проверкой.
2. В пакете `build/logic.js` (собранный JS), только когда у TS непустой `exports`. executionProblem: logic/main.ts,
   build/logic.js, examples/controls.json. Без exports ничего не меняется. ensureControls работает и для TS.
3. Снять отказы (execution.ts, moduleProgramCalls.ts), поправить Studio (programChecks.ts, checks.ts), тексты.
4. Проверки: test-modules-programs (успех, отказ без logic.js/controls, время, размер, нет сети, нет состояния), мутации,
   настоящий Chromium, документы (modules.md, module-api.md).

## План
Протокол: файл `build/logic.js` формата `globalThis.__fluxLogic = {compute,…}` (esbuild iife / Studio CommonJS-обёртка).
Хост: `modules/compute/tsHostFrame.ts` + `tsWorker.ts`, страница `ts.html` с MODULE_CSP (не COMPUTE_CSP: без connect 'self').
Окно: `createTsRunner` в src/services, `ts` в ComputeDeps (необязателен), файл 'logic.js' через fetchFile.
Главный процесс: moduleAssetPath (logic.js, ts.html, ts-host.js), electron/modules.ts, ModuleControls.required.

## Шаги
- [x] 1. Разведка, проверки «до», план (этот файл)
- [x] 2. Исполнитель TS в ModuleCompute + хост (modules/compute/tsHostFrame.ts, tsWorker.ts) + окно (src/services/moduleComputeTsHost.ts); tsc 0 ошибок
- [ ] 3. Пакет, сборка (modules/build.ts), executionProblem, главный процесс
- [ ] 4. Studio (сборка logic.js, publish, programChecks/checks)
- [ ] 5. Проверки, мутации, Chromium, документы

## Проверки «до» (run-checks modules programs, ревизия dae160c0)
37 наборов, 3 провала, не мои: test-modules-restart-ui (нет FLUX_UI_URL/FLUX_CHROME), test-modules-store-ui (нет chromium в /usr/bin),
test-modules-windows-ui (нет Vite на 5173). Остальные, включая test-modules-programs, прошли.

## Остановился
Шаг 2 и код шага 3 (executionProblem, protocol, electron/modules.ts, ModuleControls.required, ModuleFrame, build.ts buildModuleLogic) написаны, tsc чист; test-modules-programs ожидаемо красный (старая проверка отказа TS) — перепишу в шаге 5.
Дальше: шаг 4 (Studio: runtime.ts assembleLogic, publish.buildPackage, developer.ts, programChecks, checks), затем тесты (chromium-набор test-modules-ts-host.ts, programs, compute, executionProblem), документы.
