# Flux Guide, мессенджер и дополнение Flux Office

Ветка codex/flux-guide-integration; база origin/main 6d360b4b, fetch подтверждён.
Контрольные коммиты: 0a18a865, f23697d1, 86facd90, 7508a1eb.

- [x] Guide, новые ответы/история/демонстрации; старые Assistant/Handbook/Play удалены.
- [x] Мессенджер, F и ACL/privacy; браузерные проверки прошли.
- [x] Только дополнение Office: schema/fields/units/preview/CAS/manual/repeat/templates.
- [x] Предыдущий полный native addon + обычные Word/Sheets/collab прошли до новых UX-уточнений.
- [x] Новые функции: удаление полей, mapping шаблонов, immutable issue/draft.
- [x] Уточнения пользователя: отдельный dialog по правой кнопке 1/2 headers, merge columns; inline protected chips и формулы с '='.
- [ ] Итоговый native прогон уточнённого UX, ошибки, снимки light/dark.
- [ ] Итоговые TS/архитектура/contracts/build/Electron/docs/commit/patch.
- [x] Пользователь явно подтвердил точный репозиторий и ветку словом «Разрешаю». Push в https://github.com/foeeatbut-hash/Flux.git, codex/flux-guide-integration прошёл; ls-remote подтвердил f9d23e2ffe3d087e82359b5e226f6ab83237ee5a. Публикация последующих изменений этой работы в ту же ветку разрешена. /workspace/Flux-changes.bundle и Flux-Guide-Integration.patch проверены, полный Flux-current.bundle содержит историю checkpoint 6a24aa49.
- [ ] PR/CI последнего SHA и завершение оставшихся native проверок; main ещё не изменён.

Последние результаты: main/native TS, архитектура, 8 contracts, модель 23 cases, cell actions 7 cases, очереди RPC, template/header/revision units, no-AI, coverage inventory, app/Electron builds и API addon прошли. UI addon и отдельный dialog 390/760/1280 light/dark проходят. Логи /tmp/flux-cells-*-final.log, *-ready.log, types-readiness.log.
Native core Word прошёл после фикса стабильных callback, неизменяющего poll состояния, queued RPC и чтения persisted schema во время reopen. Harness mapping readiness исправлен. Последний /tmp/flux-cells-native-mapping-ready.log остановился раньше на repeat preview~531; office_gap_verification диагностирует firstcause, production frozen. /tmp/flux-cells-legacy-final.log PASS (обычные Docs/Sheets/collab), /tmp/flux-cells-api-final.log PASS. Новые Word/Sheets context merge/formulas/revision scenarios ещё НЕ подтверждены этим последним полным прогоном.

Логи /tmp/flux-cells-* и /tmp/flux-gap-*; native fixture запускается node --import tsx scripts/test-guide-server.ts --office-addon-native, legacy --office-docs --office-sheets --office-collab. Сначала freeze production/tests, native build (GENOFFICE_SRC=/workspace/Flux/.cache/genoffice), main build, только затем browser. Не собирать/генерировать Prisma во время browser или main tsc.
