# Studio этап 4в — разделы владельца и удаление обновлений/подписи из Flux

Задание: общие правила — COMMON.md (scratchpad s4); ветка `studio/stage-4c-owner` от origin/main 5f64e1fe.
Порядок: сначала функция у владельца в Studio и проверена, потом удаление из Flux.

## Шаги
- [x] 1. Разделы владельца: окно `studio/owner/console` (запросы на публикацию, выпуски и каналы, сертификаты, обновления), действия `console.cjs`, подпись `moduleSigning.ts`, команды `campaigns.ts`
- [x] 1б. Сервер: запросы на сертификат (`moduleCertRequests.ts`), назначение обновлений только владельцу, миграция `updateDelegationCleanup.ts`
- [ ] 2. Проверки владельца: `scripts/test-studio-owner-console.ts` (подпись, 403, мутации), сервер, проверка бандла
- [ ] 3. UI-проверка окна разделов (Playwright, обе темы)
- [ ] 4. Удаление из Flux: вкладка «Обновления», UpdateCampaignPanel, ModuleRequests, OwnerSignDialog, moduleSigning, пометка «устарела», справка/доки
- [ ] 5. Документы (studio.md, modules.md, studio-handoff.md), build-portable.yml (Flux Owner 1.2.4), manifests
- [ ] 6. PR

## Проверки «до»
(не снимались; наборы области — после каждого шага)

## Остановились
Шаг 1 готов, собирается (`node studio/build.cjs owner`), tsc зелёный. Дальше — проверки.
