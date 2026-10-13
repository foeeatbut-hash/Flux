# Codex 02 — Переводчик Flux Office

## Задание

Реализовать режимы размещения перевода и выявление устаревших переводов для Word и Excel, сохраняя существующие офлайн-движок, память и словари. Безопасность: sourceId/key и защищённые токены неизменны; новый файл оставляет оригинал; замена имеет копию; запись контента и метаданных перевода должна быть одним CAS-сохранением либо явно сообщать о неполной операции.

## Порядок и границы

- Пользовательский порядок: 01 → 02 → 03 → 05 → 04; branches разрешены как черновые PR.
- Ветка `codex/02-translator`, база `e889fd5` (снимок целевой ветки для этого worktree).
- Агент `runtime02` владеет `tools/genoffice/inject/translation-{common,word,sheets,bridge}.ts` и `scripts/test-translation-runtime.ts`.
- Этот агент владеет `src/components/office/TranslationBridgeContext.tsx`, UI/host providers, save integration, `server/officeBindings.ts` и route integration, `tools/genoffice/build.mjs`, task docs и новыми тестами.
- Не редактировать `src/components/office/FluxPanel.tsx`, `src/components/office/FluxOfficePanel.tsx`, `tools/genoffice/inject/{docs-collab,docs-header-merge,sheets-token-overlay,sheets-idle-chips}.ts`, `tools/genoffice/inject/sheets-*`, `scripts/test-office-*`.
- При обновлении task 02 audit и страницы программы Word/Excel выполнить требования `docs/methodology/01-design.md` §5, §8 и таблицу уровней `docs/methodology/04-testing.md`.

## Шаги

- [x] Изучить инструкции, task 02 и save/ACL/CAS интерфейсы Word, Excel и Проводника.
- [x] Добавить host-local TranslationBridgeContext и настройки размещения/обзора поверх существующего `TextTranslationPanel`.
- [x] Настроить build-копирование runtime модулей и единственного существующего `src/translate/protect.ts` в редакторы.
- [ ] Связать iframe/IPC hosts с runtime read/apply/rollback и запретить запись для read-only.
- [ ] Реализовать вставку bounded translations в Flux customXml и final-byte CAS boundary; протестировать stale/conflict/rollback/backup/copy.
- [ ] Добавить audit и обновить страницу Office, README статусы и новый наборы проверки.
- [ ] Сборка/проверки/подготовить финальный checkpoint. Не публиковать ветку без решения root о двух auto-review отклонённых путях.

## Ранняя проверка

- `npx tsc --noEmit -p .` — прошёл (exit 0; только существующее предупреждение npm о `http-proxy`).
- Сборка редактора, сценарии новых команд, серверные тесты, UI/native Microsoft Office и CI ещё не запускались.

## Текущий checkpoint

UI уже умеет выбирать scope/mode/direction/separator/order, редактировать сегменты, подтверждать непроверенные, показывать старые переводы, запускать rollback и показывать предупреждение для header/replace. Bridge пока не внедрён в host: панель работает в старом plain-text режиме пока не окажется под provider. Следующий шаг — зафиксировать точные типы runtime API с `runtime02` и подключить Word/Sheets host callbacks. Незаписанный staged metadata нельзя считать сохранённым.
