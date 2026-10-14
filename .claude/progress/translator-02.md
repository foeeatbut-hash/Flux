# Переводчик Flux Office (задание 02): остановлено владельцем 14.10.2026

Ветка `claude/translator-wip` (не влита в рабочую). Основа: рабочая ветка после PR #112 + codex/02-translator.

## Состояние
- Ядро и договор моста (translation-common.ts, translation-bridge.ts, useOfficeTranslation.ts): готово; test-translation-placement 73/73.
- Документ (Word): готово. 5 режимов + новый файл; живой `FLUX_NATIVE_ONLY=translator-word` 42/0, `cells` 121/0.
  Не проверено: отмена в совместной правке (Yjs UndoManager).
- Панель и хост (OfficeTranslationPanel, три окна документов, ворота сохранения, токен CAS): готово на поддельном редакторе;
  test-office-translation-hook 31, test-office-translator-ui 30/30.
- Таблица (Excel): шаги 1–3 из 5 (ядро, Univer, имена FLUX_TR*, патчи). Не сделано: живые сценарии `translator-sheets`
  для 6 режимов и вставки строк/столбцов, регрессия `cells`.
  Договорённость хоста: «новый файл» — `copyRequest.saved:false` → хост сам открывает «Сохранить как».

## Чтобы продолжить
1. Довести живые сценарии Таблицы (scripts/officeNativeTranslatorSheetsScenarios.ts).
2. Свести с панелью по-настоящему: прогон через панель в обоих редакторах.
3. Полный `--office-addon-native`, `--office-addon-api`, CI; затем PR в main.
