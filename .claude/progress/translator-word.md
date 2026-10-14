# Переводчик: дорожка Документа (translator-word)
Ветка __trw, старт 9028592, рабочая копия /tmp/trw, исходники GenOffice — своя копия /tmp/trw-go (GENOFFICE_SRC), сборка в /tmp/trw/public/genoffice.
Задание: createWordTranslator + мост Документа + патч flux-translation-docs + живые сценарии translator-word.

## Шаги
- [x] 1. createWordTranslator (translation-word.ts), мост docs (translation-bridge.ts), translation-docs.ts, патч, сборка all
- [x] 2. scripts/officeNativeTranslatorWordScenarios.ts + ветка translator-word в test-office-addon-native-live.ts, прогон
- [ ] 3. регрессия: cells, tsc, test-architecture, test-translation-placement

## Где остановились
Шаг 2: 44 проверки translator-word зелёные. Дальше шаг 3.
