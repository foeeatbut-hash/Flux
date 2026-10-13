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
- [x] Связать hosted Word/Sheets и локальные providers с runtime read/apply; read-only режим ограничен host-политикой.
- [x] Реализовать вставку bounded translations в Flux customXml в том же CAS сохранении; локальный редактор добавляет метаданные до единственной записи.
- [ ] Проверить stale/conflict, backup/copy, build/runtime и native Word/Excel.
- [ ] Добавить audit и обновить страницу Office, README статусы и новый наборы проверки.
- [ ] Сборка/проверки/подготовить финальный checkpoint. Не публиковать ветку без решения root о двух auto-review отклонённых путях.

## Ранняя проверка

- `npx tsc --noEmit -p .` — прошёл (exit 0; только существующее предупреждение npm о `http-proxy`).
- `node --import tsx scripts/test-translation-staging.ts` — прошёл: общий AppSetting между двумя server views, права actor/base, CAS-конкуренция, одноразовое потребление.
- `node --import tsx scripts/test-translation-package.ts` — прошёл: merge/read, сохранение прежних привязок и снимка шаблона, дедупликация записи, отказ на повреждённой части.
- `node --import tsx scripts/test-guide-server.ts --office-docs --office-sheets` — заблокирован: отсутствует пересобранный GenOffice asset; сборку не запускать, пока runtime-модули не заморожены.

## Текущий checkpoint

UI умеет выбирать scope/mode/direction/separator/order, редактировать сегменты, подтверждать непроверенные и показывать историю/устаревшие записи. Hosted и local providers подключены к `flux:translation-read/apply`; existing-file persistence stages metadata and merges it into the same content CAS/native local write. Durable stage tokens are in shared AppSetting with actor/file/base binding, TTL, CAS claim and one-use consumption. New-file Word/Sheets uses immutable save-as paths. Remaining: run frozen runtime tests/build, Office native scenarios, server/coverage suites, finish audit/README task docs, and ask root to publish only after the remaining checks.
