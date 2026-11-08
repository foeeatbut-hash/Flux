# Flux Studio, этап 3, часть 3а — Языки логики и пределы исполнения

Задание: от руководителя (сессия 8 ноября 2026), решение владельца 7 ноября:
языки — TS/JS, Python (Pyodide), WebAssembly (C, C++, Rust, Go, C#). 3б (подключения) — НЕ здесь.
Ветка `studio/stage-3a` от `origin/main` fbaa7505. Один PR черновиком в `main`.

## Шаги
- [x] 1. Общий механизм: modules/engine (types, json, controls, wasmInspect), manifest language/sourceLanguage/platform, подпись (claims, verify, execution), набор modules-languages
- [x] 2. WebAssembly: engine (wasm.ts, wasmInspect.ts, кэш), два ABI (реактор и WASI-команда для C#), фикстуры C/C++/Rust/Go/C# собраны, набор modules-wasm
- [x] 3. Python: Pyodide 0.29.5 (devDependency, в dist/modules/_compute), общий Worker в изолированном хосте, выгрузка по простою (localStorage flux.modules.pythonIdleMinutes, 5)
- [x] 4. Пределы: scheduler, moduleCompute, контрольные при первом запуске (moduleControls), протокол; нативный набор modules-compute-native
- [ ] 5. Точность и сквозная проверка (Electron), документы, PR

## Итоги проверок «до» (origin/main)
`run-checks modules architecture`: 18 наборов, провалено 7 — все из-за среды контейнера:
channels/promotion/store/feedback (клиент Prisma из /home/user/Flux без таблиц модулей),
publishing, store-ui/restart-ui (нет chromium по FLUX_CHROME / Vite). tsc: 0 ошибок.
`check:verification`: 1 проблема (symlink public/genoffice) — среда.

## Находки по ходу
- Токены: dotnet-sdk-8.0 поставился из apt; builds.dotnet.microsoft.com закрыт прокси.
- TinyGo 0.39 скачан с GitHub-релиза (deb), работает без wasm-opt.

## Находки
- Chromium запрещает класть WebAssembly.Module в IndexedDB (DataCloneError): дискового кэша компиляции нет; компиляция один раз на выпуск в окне, модуль передаётся в Worker.
- Остаток: документы (modules.md программа, roadmap, plan, README roadmap), docflow-формулировка, мутации, merge origin/main, PR, CI.
