# program-policy

Задание: два долга по `flux.programs.call` — (1) запрет администратором `@program:<id>` по образцу `@internet`/`@lan`;
(2) настоящие Pyodide/WebAssembly/TypeScript в наборе программа→программа, манифест проверок и CI, случай в native-стенде; (3) документы.
Ветка push: claude/flux-stage-1-pjmxgt (локальная — worktree-agent-a59ce21971c5e9b76). Ревизия старта: 5b507e1c. Порты 3250/5250.

- [x] Шаг 1: запрет администратора (главный процесс, сервер, экран, проверки)
- [ ] Шаг 2: набор на настоящих движках, манифест/CI, native-стенд
- [ ] Шаг 3: документы (modules.md, module-api.md, studio-next.md)

Проверки: tsc 0; test-modules-programs, test-modules-journal, test-modules-store-ui (Vite 5250) — зелёные.
Дальше: шаг 2.
