# Наборы, которые пропускают себя

Набор «пропустил себя», если вышел с кодом 0, ничего не проверив. Зелёный код
в таком случае врёт: job CI зелёный, а проверки не было.

## Что сделано

- `scripts/verifySkip.ts` — единственный способ пропустить набор вслух.
  Печатает `FLUX_VERIFY_SKIP: <причина>` (его читает раннер
  `verification/runner.ts` и показывает как SKIP).
- Если в окружении `FLUX_REQUIRE_NO_SKIP=1`, пропуск становится провалом
  (код 1, даже если набор потом сам вызывает `process.exit(0)`). Переменная
  стоит в job'ах, где эти наборы обязательны: `verify-modules.yml`
  (Windows) и job `checks` в `build-studio.yml`.
- `scripts/run-checks.ts` в итоге печатает «пропущен (не проверен): набор —
  причина» и при `FLUX_REQUIRE_NO_SKIP=1` завершается с кодом 1. Ловит и
  `FLUX_VERIFY_SKIP:`, и строки `SKIP ...`.
- Job'ы CI запускают наборы напрямую (`node --import tsx scripts/...`), а не
  через `npm run check:programs -- --run`. Раннер, у которого любой статус
  кроме PASS даёт код 1, в CI не вызывается нигде; поэтому защита стоит в
  самих наборах.

## Таблица

| Набор | Когда пропускает себя | Выполняется в CI |
|---|---|---|
| test-modules-page | нет `FLUX_CHROME` | verify-modules (Windows, Chrome задан) |
| test-modules-openfile | нет `FLUX_CHROME` | verify-modules; build-studio (Ubuntu, google-chrome) |
| test-modules-windows | нет `FLUX_CHROME` | verify-modules; build-studio |
| test-modules-native | не Windows и не Linux с DISPLAY; нет файлов сборки | verify-modules (после `build:electron`) |
| test-modules-page-native | то же; нет `dist/modules` | verify-modules |
| test-modules-compute-native | то же; нет `dist/modules/_compute` | verify-modules |
| test-modules-connections-native | то же; нет `dist/modules/_shell` | verify-modules |
| test-modules-flux-ui-live | то же | verify-modules |
| test-mail-shared | в общем ящике нет писем / нет письма с вложением (нужна почтовая фикстура) | нигде: только ручной запуск и манифест `collaboration.json` |
| test-office-addon-native-live | без `FLUX_OFFICE_NATIVE_READY` выходит с кодом 2 (это провал, не пропуск); нужны настоящий Office и фикстура | нигде: нет ни в workflow, ни в манифесте; `run-checks` без `--live` его не берёт |
| test-windows-files-native | не Windows — SKIP; нет второго тома — SKIP отдельных проверок | verify-windows-shell (Windows) |
| test-e3-probe | нет PowerShell; часть проверок только Windows | verify-windows-shell |
| test-windows-files | символьная ссылка без права SeCreateSymbolicLink (EPERM) — одна проверка | verify-windows-shell, build-portable, verify-drafts-panel |
| test-office-bus | нет `FLUX_PG` — проверки PostgreSQL пропущены | нигде в workflow; только через `npm run check` локально |
| test-studio-workspace, test-studio-tsbuild | нет ссылок / нет сетевого адреса кроме петли — часть проверок | build-studio (Ubuntu): часть проверок пропускается |

Строки `SKIP ...` без `FLUX_VERIFY_SKIP:` (windows-files-native, e3-probe,
windows-files) раннер не распознаёт. Они пропускают отдельные проверки внутри
набора, а не весь набор; `run-checks` их теперь перечисляет.

## Что осталось и почему

- test-mail-shared и test-office-addon-native-live в CI не включить: первому
  нужен настоящий почтовый ящик с письмами, второму — Word/Office и
  собранные редакторы. Пропуск теперь виден (`FLUX_VERIFY_SKIP`, итог
  `run-checks`), но обязательным ни в одном job не является.
- Частичные пропуски (второй том, PostgreSQL, ссылки) оставлены как есть:
  набор в целом выполняется. Если нужно сделать их обязательными в
  Windows-job, это отдельное решение.
- `FLUX_REQUIRE_NO_SKIP` в `verify-modules.yml` и `build-studio.yml` только
  что включён: если какой-то набор там пропускал себя молча (например нет
  `dist/modules/_compute` после сборки), job теперь покраснеет. Это ожидаемо:
  раньше он был зелёным без проверки. Проверено только в контейнере на Linux;
  поведение на Windows-раннере покажет первый прогон CI.
