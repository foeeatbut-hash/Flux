# Flux Guide, мессенджер и дополнение Flux Office

Ветка codex/flux-guide-integration; база origin/main 6d360b4b, fetch подтверждён.
Контрольные коммиты: 0a18a865, f23697d1, 86facd90.

- [x] Guide, новые ответы/история/демонстрации; старые Assistant/Handbook/Play удалены.
- [x] Мессенджер, F и ACL/privacy; браузерные проверки прошли.
- [x] Только дополнение Office: schema/fields/units/preview/CAS/manual/repeat/templates.
- [x] Предыдущий полный native addon + обычные Word/Sheets/collab прошли до новых UX-уточнений.
- [x] Новые функции: удаление полей, mapping шаблонов, immutable issue/draft.
- [x] Уточнения пользователя: отдельный dialog по правой кнопке 1/2 headers, merge columns; inline protected chips и формулы с '='.
- [ ] Итоговый native прогон уточнённого UX, ошибки, снимки light/dark.
- [ ] Итоговые TS/архитектура/contracts/build/Electron/docs/commit/patch.
- [ ] PR/CI текущего SHA: push ранее отклонён auto-review; отдельное разрешение публикации запрошено и не получено.

Последние результаты: main TS проходил, архитектура и 8 contracts прошли; API addon исправленная fixture проходит; UI addon 390/760/1280 light/dark проходит. Модель 23 cases, cell actions 7 cases проходят.
Текущий узкий остаток: native Sheets TS (девять ошибок, включая runtime renderParts scope) исправляет office_sheets_cells, затем rebuild Sheets/main. Docs helper extraction type references исправлены, typed docs build готов; повторить native Docs TS. Новые actual Sheets/Word helpers дописывает office_gap_verification. Browser ещё НЕ запущен после последних уточнений.

Логи /tmp/flux-cells-* и /tmp/flux-gap-*; native fixture запускается node --import tsx scripts/test-guide-server.ts --office-addon-native, legacy --office-docs --office-sheets --office-collab. Сначала freeze production/tests, native build (GENOFFICE_SRC=/workspace/Flux/.cache/genoffice), main build, только затем browser. Не собирать/генерировать Prisma во время browser или main tsc.
