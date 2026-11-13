# studio-typecheck
Задание: сверка типов TypeScript в «Собрать» Studio (настоящий компилятор в отдельном потоке, виртуальный хост, кэш программы, предел времени, проверки, документы).
Ветка: worktree-agent-a4af98f1eb2a06296 → push в claude/flux-stage-1-pjmxgt. Ревизия старта: 561dc544.
Шаги:
- [x] 1 ядро сверки (tsTypes.ts, tsTypeWorker.ts, хост, сборка потока)
- [ ] 2 проверки (test-studio-tsbuild, мутация, UI-случай), заготовки и пример проходят strict
- [ ] 3 документы (studio.md, studio-next.md), замеры, отчёт
Проверки «до»: наборы studio-tsbuild/project/bundle зелёные до правок (tsc exit 0 после). Замеры: esbuild 450-580 мс, +типы тёплые те же, холодная +0.9 с; поток 5.2 МБ.
