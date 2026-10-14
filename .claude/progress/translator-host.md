# translator-host — хост переводчика Flux Office (дорожка окна Flux)

Ветка `__trh` (/tmp/trh), старт 9028592. Задание: хук useOfficeTranslation, подключение в LocalOfficeEditor/OfficeAppEditor/OfficeHost,
панель TextTranslationPanel (+ провайдер в FluxOfficePanel), тесты с фальшивым редактором, снимки, проверки.
Не трогать: translation-{word,sheets,bridge}.ts, patches.mjs.

## Шаги
- [ ] 1. Контекст моста + хук useOfficeTranslation (+ officeTranslationLinks.ts) + модульный тест
- [ ] 2. Подключение в OfficeHost, OfficeAppEditor, LocalOfficeEditor (+ FluxOfficePanel провайдер)
- [ ] 3. Панель TextTranslationPanel
- [ ] 4. Playwright-набор с фальшивым редактором + снимки
- [ ] 5. Проверки (tsc, architecture, translation-*, office-local, office-flux-part)

## Проверки «до» (9028592): все 7 наборов exit 0 (translation-api/package/staging/placement, office-local, office-flux-part, architecture).

## Где остановились
Начало шага 1.
