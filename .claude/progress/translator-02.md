# Переводчик Flux Office (Codex 02) — доделка

Ветка `__tr` (рабочая копия /tmp/cxtr), база: origin/claude/custom-table-builder-design-38h1b8 + слияние codex/02-translator.
Задание: docs/codex/task-02-translator.md, ТЗ §15–16, аудит docs/codex/task-02-audit.md.

## Шаги
- [x] 0. Слияние codex/02-translator (README — наш), рабочая копия, проверка трёх наборов Codex: пройдены
- [x] 1. Чистое ядро: translation-common.ts (+shim translation-protect.ts), модульные тесты на режимы (scripts/test-translation-placement.ts, 73 проверки)
- [x] 1б. Контракт: translation-bridge.ts (протокол), useOfficeTranslation.ts (типы хука), заглушка translation-sheets.ts; translation-word.ts — РЕАЛЬНОЕ чистое ядро Документа (чтение/план/применение к JSON), живое подключение — заглушка createWordTranslator
- [ ] 2. Word (дорожка Документа): createWordTranslator + транзакция/один шаг «назад»/откат + new-file через buildDocBytes + патч подключения
- [ ] 3. Sheets: translation-sheets.ts (6 режимов, имена FLUX_TR_*, сдвиг строк/столбцов, один шаг отмены)
- [ ] 4. translation-bridge.ts + патчи patches.mjs, сборка редакторов
- [ ] 5. Хост: хук useOfficeTranslation, четыре окна (OfficeHost, OfficeAppEditor, LocalOfficeEditor), лента, панель (предпросмотр/подтверждение/устаревшие)
- [ ] 6. Живые сценарии translator (Word, Sheets), прогоны
- [ ] 7. Снимки, документы (audit, office.md, README), полный прогон

## Проверки «до»
test-translation-staging/package/api, test-translate, test-translate-file: все пройдены (exit 0) на слитой ветке.

## Контракт (зафиксирован, дорожки идут от него параллельно)
- Протокол и каналы: tools/genoffice/inject/translation-bridge.ts (TRANSLATION_CHANNELS, EditorTranslator {read, apply, rollback}); типы тел и коды отказов TrErrorCode — translation-common.ts.
- Документ: события fluxTranslationRead/Apply/Rollback -> flux:translation-read/applied/rolled-back (askFrame). Таблица: каналы flux:translation-*-request -> flux:translation-read/applied/rolled-back.
- apply: dryRun -> preview; иначе ОДНА транзакция/группа «назад», ответ records + removeRecords (повтор без дублей) + stepId; любой отказ — документ цел и code; busy при втором запросе; rollback(stepId) — undo только своего верхнего шага (code cannot-rollback иначе).
- Ключ фрагмента: Документ — закладка FLUX_7a<30hex> (`w:`), перевод-абзац FLUX_7b<те же 30hex>; Таблица — имена FLUX_TR_<id> (исходник) и FLUX_TRT_<id> (место перевода), сдвигаются со вставкой строк/столбцов. Запись журнала несёт sourceHash.
- Хост: src/components/office/useOfficeTranslation.ts — OfficeTranslationEditorLink / OfficeTranslationFileLink / gate (createTranslationGate готов) / useOfficeTranslation (заглушка). Порядок: gate.begin -> file.committed -> editor.apply -> file.saveWithTranslation(delta, baseHash) -> при отказе editor.rollback.
- Чистое ядро Таблицы уже есть: planSheet (вставки справа налево, итоговые адреса), composeInline/peelTarget, validateTarget, uniqueSheetName. В заглушке translation-sheets.ts остаются readSheets/planSheetsApply/createSheetsTranslator.
- Перенос: src/lib/officeTranslationPackage.ts -> office/translationPackage.ts (electron не импортирует src/: чинит давний провал test-architecture из слияния Codex).

## Проводка, которой ещё нет
1. patches.mjs: import './flux/translation-bridge' в apps/docs/src/renderer/App.tsx и apps/sheets/src/renderer/App.tsx (рядом с flux-sheets-collab-import) + вызов installTranslationBridge.
2. patches.mjs: window.__fluxSheets.save = handleSave для «новой книги» (App.tsx сохраняет saveContext).
3. Хосты: TranslationBridgeProvider вокруг TextTranslationPanel в FluxOfficePanel (view translator); useOfficeTranslation в OfficeHost, OfficeAppEditor, LocalOfficeEditor; X-Flux-Translation-Token в OfficeHost.save / office:ipc / translationDelta в Local.
4. Живой набор: scripts/officeNativeTranslatorScenarios.ts + ветка `FLUX_NATIVE_ONLY=translator` в test-office-addon-native-live.ts (по образцу `cells`: вызывается runNativeXxx({fixture, folderId, stamp, created, api, raw, upload, check, waitFor, resetPage, navigateOffice, openPanel, page}) и context.close(); return).

## Где остановились
Шаг 1 и контракт готовы; дальше три дорожки (Документ, Таблица, хост+панель+лента).
