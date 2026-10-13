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
Native core Word, repeat и явное mapping target UUID прошли; /tmp/flux-cells-native-repeat-ready.log остановился в Sheets schema sync: GET office-state возвращал storage part/sheet вместо documentPart/sheetName. Root исправил GET + добавил API round-trip assertions; /tmp/flux-cells-api-location.log PASS. officeNativeSchema принимает проверенный актуальный sheetName/address из native reply (перемещение диапазона), unit PASS. Новые main TS/build PASS (/tmp/flux-cells-types-location.log, flux-cells-app-location.log). Wordtemplate false-negative оказался harness race: predicate был true до save; теперь ждёт все5частей customtemplate. Ожидаемая подпись Sheet field уточнена по OfficeField.displayName (group · key). office_gap_verification запускает fullnative /tmp/flux-cells-native-location.log, production frozen. Нужно final Electron после текущихsource fixes и native результатов. /tmp/flux-cells-legacy-final.log PASS (обычные Docs/Sheets/collab). Новые Word/Sheets context merge/formulas/revision scenarios ещё НЕ подтверждены этим последним полным прогоном.

Логи /tmp/flux-cells-* и /tmp/flux-gap-*; native fixture запускается node --import tsx scripts/test-guide-server.ts --office-addon-native, legacy --office-docs --office-sheets --office-collab. Сначала freeze production/tests, native build (GENOFFICE_SRC=/workspace/Flux/.cache/genoffice), main build, только затем browser. Не собирать/генерировать Prisma во время browser или main tsc.

Актуальный checkpoint: полный native /tmp/flux-cells-native-location-ready.log завершился exit1 (8 failures). Word/core/template/удаление поля прошли; Sheets после подтверждённой загрузки диапазона возвращает пустой A1 вместо заголовка, также не проходит чтение A5. Позднее GenOffice pageerror: [redi] Expect 1 dependency item(s) for id ry but get 0. Полный новый UX объединения/формул и issue/draft пока не подтверждён. Electron после source fixes PASS /tmp/flux-cells-electron-location.log; архитектура PASS /tmp/flux-cells-architecture-loaded.log.
Следующий шаг: диагностический native прогон. Harness уже сохраняет /tmp/office-addon-native-sync.xlsx и SHEETS_HEADER_SYNC_DIAGNOSTIC при сбое, проверяет физическую A1 worksheet/sharedStrings вместо любых XML (customXml мог давать ложный PASS). Последнее изменение ещё не запускалось в браузере. Субагенты office_gap_verification и office_sheets_cells остановились из-за usage limit, не завершили исправление. Минифицированный ry — controller со dependencies context/injector/sheetSkeleton/contextService/commandService/renderManager/scrollManager; не обходить ошибку ослаблением тестов.
