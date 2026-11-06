# Flux Studio, этап 2 «Распространение» — файл хода и ПОЛНАЯ ПЕРЕДАЧА

Для исполнителя без контекста (новая сессия, разговора не видела). Прочти этот
файл целиком, затем `CLAUDE.md` и `AGENTS.md`, потом только нужные разделы
планов. Состояние на коммите, указанном внизу («Состояние ветки»).

## Цель этапа
Строка «2. Распространение» таблицы в `docs/studio-handoff.md`, раздел 2
(шаги (а)–(г) и критерии приёмки). Устройство — `docs/roadmap/modules.md`:
«Запрос на публикацию и проверка владельцем», «Цепочка доверия», «Пакет
модуля», «Публикация», «Flux Store», «Ошибки и предложения по подпрограммам»,
«Решение владельца (6 ноября 2026)». Страница программы:
`docs/methodology/03-programs/modules.md`. Draft PR #139 в `main`.

Критерии приёмки этапа (из таблицы): выпуск без подписи владельца (в том числе
подписанный только разработчиком), с изменённым куском или отозванным ключом
не запускается, прошлая проверенная версия работает; права проверяет сервер;
подпрограмма ставится из Store без выпуска portable, новая версия — только по
«Обновить» (или с включённым автообновлением); возврат версии работает без
связи; отзыв откатывает всех; обращение по подпрограмме видно и во Flux, и
разработчику, а данные проектов разработчику не уходят; снимки Store в обеих
темах и без прозрачности.

## Ветка и правила
Ветка `studio/stage-2` (от `origin/main` 0beb4d6). Push только в неё, без
force-push; перед push — `git fetch origin`, `git merge origin/studio/stage-2`
и `git merge origin/main` (без rebase). Wip-коммиты не переписывать. Файлы
Документооборота (`docflow`, `vdr`) и панель «Черновики» не трогать.
Коммиты по-русски, про причину; в конце сообщений — строки Co-Authored-By и
Claude-Session из напоминания сессии; имя модели в коде, комментариях,
коммитах и PR не писать. Подготовка копии: `git checkout -B studio/stage-2
origin/studio/stage-2`, `CLAUDE_CODE_REMOTE=true scripts/session-start.sh`
(после правки схем Prisma запускать снова: перегенерирует клиентов).
Узнать CI: `gh api repos/:owner/:repo/commits/<SHA>/check-runs`
(GraphQL из сессии закрыт: `gh pr view` не работает, только REST), логи —
`gh api repos/:owner/:repo/actions/jobs/<id>/logs`.

## Решения владельца (все действуют)
- Выпуск подписывает ТОЛЬКО владелец; подпись разработчика стоит на запросе и
  показывает автора, но выпуск не делает.
- Один ключ подписи — `keys.update` (тот же, что у обновлений Flux, корень
  `electron/updateKey.ts`), отдельного ключа модулей нет (6 ноября 2026);
  подписи разных видов не спутать за счёт приставок: `FLUXMOD1` выпуск,
  `FLUXMODREQ1` запрос, `FLUXMODCERT1` сертификат, `FLUXMODREV1` отзыв,
  `FLUXMODPIN1` откат канала. Код так и устроен, менять не нужно.
- Новая версия — только по решению человека («Обновить»); автообновление —
  настройка Store, по умолчанию ВЫКЛЮЧЕНО (общий переключатель у человека и
  свой у подпрограммы; срабатывает один раз при запуске Flux).
- Ставится пользователю, не компьютеру; на другом компьютере — «Установить
  здесь». Хранятся 3 последние версии и выбранная: возврат работает без связи;
  после возврата автообновление этой подпрограммы выключается.
- Отзыв выпуска откатывает установленное на ближайшую неотозванную версию —
  единственный случай смены версии без человека.
- Вид Store — как Microsoft Store (исключение уже записано в
  `docs/methodology/01-design.md`, таблица исключений): карусель, обложки,
  сжимающаяся шапка, подъём карточки; стекло окна `.fx-glass`.
- Разработчику рабочий канал только с правом `module.publish`; иначе запрос
  идёт в тестовый. Вопрос владельцу «выкладка E3Flux» и «связи E3» открыты.
- Данные проектов разработчику подпрограммы не уходят (шаг (г)).

## Сделано

### (а) Цепочка доверия и публикация — коммиты 2d4518c…4b4b45c
`modules/trust/{envelope,claims,bundle,verify,diff,owner}.ts` (подписанные
записи, пакет, проверка, разница); таблицы `ModuleRequest/Release/Chunk/
Certificate/Revocation` в трёх схемах `prisma/schema*.prisma`;
`server/moduleStore.ts`, `server/routes/modulePublishing.ts`;
`electron/moduleCache.ts` (кэш проверенных, перепроверка на каждом чтении,
отзывы только добавляются), `electron/moduleSigning.ts` (подпись владельца
из хранилища), `electron/modules.ts` (протокол `flux-module://`);
окно: `src/services/moduleReleaseService.ts`, `src/screens/ModuleRequests.tsx`,
`src/components/modules/*`. Наборы: `test-modules-trust`,
`test-modules-publishing`.

### (б) Права, роль, каналы, откат — коммит 2538215
- `module.develop`, `module.publish` (`src/lib/permissions.ts`, закрыты по
  умолчанию); системная роль «Разработчик» `MODULE_DEVELOPER`
  (`server/routes/users.ts` BUILTIN_ROLES, `src/lib/roles.ts`, значок `code`).
- Сервер проверяет права, обязательное «что нового», рабочий канал только с
  `module.publish` (`server/routes/modulePublishing.ts`, `deps.can` передаёт
  `server.ts` через `server/updates.ts`).
- Тестовый канал — назначенные владельцем (`AppSetting modules.testers`,
  `server/moduleChannels.ts`, `server/routes/moduleChannels.ts`: `/me`,
  `/testers`, `/pins`); панель в разделе владельца
  `src/components/modules/ModuleTestersPanel.tsx`.
- Откат: `FLUXMODPIN1` (`PinClaim`, `readPins`, `ChannelCaps` в
  `modules/trust/*`), таблица `ModuleChannelPin`, хранение в кэше
  (`pins.json`), подпись `electron/moduleSigning.ts` kind `pin`, кнопки
  «Вернуть канал сюда»/«Снять откат» в `ModuleTrustPanel.tsx`.
- Набор `scripts/test-modules-channels.ts` (37 проверок, мутации ловятся).

### (в) Flux Store — коммиты e3d7342 (сервер/главный процесс) и 0be5a98 (экран)
- Модель витрины (чистая): `modules/store/model.ts`; блок `store` в
  `manifest.json` (`modules/contract.ts`, `modules/schemas.ts`: категория,
  описание, цвет, требования, зависимости, должности, снимки `store/*.png`).
- Таблицы (3 схемы): `ModuleStoreEntry` (допуск, устаревшая, закрепление,
  обязательность), `ModuleInstall` (установки человека), `ModuleStoreLog`
  (журнал), `ModuleReview`. Вспомогательный скрипт добавления моделей во все
  три схемы был в /tmp — повторить вручную: в MariaDB длинным полям нужен
  `@db.LongText`.
- Сервер: `server/moduleListings.ts` (сборка витрины, кэш манифестов по
  выпуску), `server/routes/moduleStore.ts` (`/store`, `/installs`,
  `/installs/auto`, отзывы, `/store-admin`, `/store/:id/{admission,pin,
  required}`, снимок `/releases/:id/file`).
- Главный процесс: `electron/moduleSelection.ts` (выбор установленного по
  человеку, файл `selection.json`, пометка `dirty` для изменений без связи),
  `electron/moduleStoreIpc.ts` (IPC `modules:state|activate|sync|install|
  remove|rollback|synced`, сверка отпечатка разрешений `permissionsDigest`),
  `ModuleCache.resolve/available/previous/prune(selected)`,
  `electron/modules.ts` (протокол отдаёт только установленное и проверенное);
  каналы в `electron/ipcAllow.ts`.
- Окно: `src/services/moduleStoreService.ts` + `moduleStoreActions.ts`
  (установка: скачать и проверить → политика сервера → выбор в главном
  процессе; сверка при входе/фокусе/событиях сокета; обязательные;
  автообновление при запуске), `src/store/moduleStoreState.ts`,
  `src/workspace/installedSections.ts` + `syncInstalledSections` в
  `sections.tsx` (установленные — в Пуск, панель задач, карточки
  `ModuleLaunchActions`, `ModuleHost`), `src/screens/StoreScreen.tsx`,
  `src/components/store/*` (+ `store.css`), `StoreSync` в `App.tsx`,
  значок `StoreAppIcon`.
- Реестр проверок: маршруты `/module-requests` и `/store` и источники
  добавлены в `verification/manifests/modules.json` (без этого красный
  `contracts` в CI, см. ниже).
- Наборы: `scripts/test-modules-store.ts` (72), `scripts/test-modules-store-ui.ts`
  (44, замеры по `getBoundingClientRect/getComputedStyle`, подделка главного
  процесса в `scripts/fixtures/store-ui.tsx`, сервер перехватывается в наборе),
  страница программы и `docs/roadmap/modules.md` обновлены.
- Снимки: `SHOT=/tmp/…/store.png` даёт home/page/page-compact/dialog/library
  в светлой, тёмной темах, со стеклом и без (`-solid`) и admin; сняты и
  просмотрены глазами в этой сессии (в репозиторий не входят).

## Осталось

### Остаток (в)
1. Открытая подпрограмма предлагает перезапуск на новую версию, идущий расчёт
   не прерывается («Выпуск и обновления» плана): сейчас новая версия подхватывается
   при следующем открытии окна подпрограммы. Файлы: `src/screens/ModuleHost.tsx`,
   `moduleStoreActions.ts`. Критерий: баннер «Вышла версия X — перезапустить»
   в окне подпрограммы, перезапуск только по кнопке.
2. Данные модуля: «удалить и данные», копия данных перед обновлением при смене
   формата — у подпрограмм пока нет постоянных данных (этап 3, подключения и
   хранилище); флаг `keepData` сейчас только в журнале.
3. Постепенный выпуск (сначала тестовый, затем всем) работает через каналы;
   отдельной кнопки «повысить из тестового в рабочий» нет — владелец выпускает
   ту же версию заново нельзя (версия занята): нужен путь «перевести выпуск в
   рабочий канал» (подписанное назначение или перевыпуск нового номера). Решить
   с владельцем.
4. Fixture-проверка на PostgreSQL и MariaDB для новых таблиц Store/пинов:
   `test-modules-store` и `test-modules-channels` идут только на SQLite;
   `test-modules-publishing` умеет `FLUX_MODULES_PG_FIXTURE_URL` /
   `FLUX_MODULES_MARIA_FIXTURE_URL` — сделать так же. MariaDB в контейнере нет.
5. Электрон-часть живьём (протокол, IPC `modules:*`, подпись) и Windows — не
   проверены; нужен CI `verify-modules.yml`/`modules-windows` (зелёный на
   последнем SHA, см. ниже) и ручная проверка на Windows.
6. Сообщения в Store администратору о всплеске сбоев → «отозвать выпуск»:
   показ готов (`listing.crashes`), источник данных — шаг (г), п. 4.

### (г) Ошибки и предложения по подпрограммам — НЕ НАЧАТ
План — раздел «Ошибки и предложения по подпрограммам» `docs/roadmap/modules.md`.
Существующее: `feedback/` (договор `contracts.ts`, `transitions.ts`,
`fingerprint.ts`, пакет), `server/feedback/*` (таблицы заданы ДВАЖДЫ: DDL в
`server/feedback/tables.ts` и Prisma; расхождение ловит `test-feedback-ddl`),
`server/routes/feedback.ts`, окно `src/feedback/*`,
`src/components/feedback/ProblemPanel.tsx`, `src/screens/FeedbackScreen.tsx`.
Пункты и критерии готовности:
1. Адресат «подпрограмма» в обращении: поля `moduleId`, `moduleVersion`,
   `moduleChannel` (+ разработчик) в `SubmitFeedbackV1` (`feedback/contracts.ts`,
   строгий разбор — добавить поле), в таблицу `FeedbackReport` (DDL + 3 схемы),
   отпечаток дублей включает подпрограмму и версию. Критерий: обращение по
   подпрограмме видно в «Замечаниях и предложениях» (фильтр «по подпрограммам»)
   и разработчику с сертификатом на неё, статус и ответы общие.
2. Автоопределение по активному окну в «Сообщить о проблеме» (`ProblemPanel`):
   активное окно `/module/<id>` → адресат выбран заранее, переключатель «эта
   подпрограмма / сам Flux / другая установленная». Кнопка «Сообщить о
   проблеме» на странице Store уже шлёт событие `flux:report-module`
   (`StoreScreen.tsx`) — подписать на него панель.
3. Разделение пакета: разработчику — только его часть (подпрограмма, версия,
   версия API, канал, журнал подпрограммы, стек, снимок её окна, среда), БЕЗ
   данных проектов и журналов остальной Flux; Flux/администратору — полный
   пакет. Критерий: набор доказывает, что разработчик не получает данные
   проектов (по образцу `test-feedback-privacy`); данные расчёта — только по
   галочке «приложить входные данные».
4. Обезличенные счётчики сбоев по версиям (упала, предел времени/памяти, отказ
   моста) без данных и имени; копятся без связи и уходят при связи; вид в
   Store администратору (`listing.crashes`, экран допуска) и график
   разработчику (Studio, этап 4).
5. «Исправлено в X — Обновить»: переход «готово» с версией исправления;
   когда выпуск X появился в Store — уведомление автору с кнопкой
   (ссылка `/store?module=<id>`), затем «Проблема ушла?».
6. Переадресация, «У меня тоже», известные проблемы (`listing.known`),
   передача обращений при отзыве сертификата — по плану; предел частоты общий.
Наборы: `test-feedback-contracts/transitions/privacy/ddl` + новый
`scripts/test-modules-feedback.ts` с мутациями (падает без правки).

### Хвосты этапа 4 (Studio)
Отправитель запроса (ключ в `safeStorage`, сборка `build/runtime.js` —
`buildModuleRuntime` в `modules/build.ts`), сверка хеша сборки, «Проверить в
работе», замечания к строкам кода, уведомление владельцу о новом запросе
(сейчас `broadcast('modules:requests')`), список закрытых обращений в «что
нового».

## Ловушки
- Нет `strictNullChecks`: сужение по `ok` не работает (`Verified<T>.why` есть
  в обоих вариантах).
- Запрос и выпуск — одни и те же байты (`blobId` = id запроса).
- Vite в `.claude/worktrees` НЕ видит правок (`vite.config.ts` игнорирует
  `**/.claude/**`): перед каждым прогоном UI-набора перезапускать Vite —
  `scripts/test-modules-store-ui.ts` нужен свой Vite на порту ≠ 3000 и
  `FLUX_CHROME=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome`
  (путь chromium-1194 из памяти устарел). Мутации UI без перезапуска Vite
  «не ловятся» — это обман.
- Автопрокрутка Playwright к карточке перед щелчком прокручивает область и
  сжимает шапку страницы: страницу в наборе открывают DOM-щелчком.
- Хуки/обёртка Bash в этой среде отвергают сложные команды (heredoc +
  git/переменные в одной строке): писать скрипты файлом в scratchpad.
- Роль ADMIN проходит все `userCan` кроме `admin.*`: право `module.develop`
  у ADMIN есть всегда, а присылать запрос он всё равно не может без
  сертификата ключа.
- `modules:sync` качает только указанные выпуски; «Проверить на этом
  компьютере» в панели владельца качает все (`moduleReleaseService.sync`).
- `test-modules-publishing` и фикстура `scripts/fixtures/moduleTrust.ts`:
  запросы по умолчанию идут в тестовый канал (иначе нужен `module.publish`).

## Какие наборы запускать
`node_modules/.bin/tsx scripts/run-checks.ts test-modules test-architecture
test-schema test-security test-owner-updates test-updates test-roles
test-permissions verification` — после правок; перед PR полный `npm run check`.
Мутации: подмена строки, прогон набора, откат (применено ко всем новым
наборам; падает без правки).
Падают из-за ОКРУЖЕНИЯ (не из-за работы): `test-schema-databases`
(фикстуры MariaDB/PG), все `*-live` и `test-feedback-{chunks,idempotency,
multi-server,privacy,read,panel-ui}` (нужны `FLUX_USER/FLUX_PASS` и сервер :3000),
`test-users-screen-ui`, `test-modules-store-ui` без `FLUX_UI_URL`+`FLUX_CHROME`.
Результат на этом SHA: `tsc --noEmit` 0; `test-architecture`, все
`test-modules-*` (кроме UI без Vite), `test-roles/permissions/security/updates`
зелёные.

## Состояние CI и ветки
PR #139 (draft). На SHA 0be5a98 check runs: `contracts` — КРАСНЫЙ, остальные
(`security-db`, `windows-shell`, `remaining-api-fixture`, `modules-windows`)
зелёные, `office-native` шёл. Первая причина красного `contracts`:
`scripts/verification-inventory.ts` — «Пробелы реестра: routes
[/module-requests]» (раздел из шага (а) не заведён в
`verification/manifests/modules.json`); это же касалось бы `/store`.
Исправлено вместе с этим файлом (маршруты и источники добавлены, инвентаризация
чистая локально) — проверить зелёный `contracts` на новом SHA.
Windows-проверок вручную нет; MariaDB не проверялась.

## Продолжение 6 ноября — контрольная точка

Остаток (в) и шаг (г) реализованы в рабочем дереве: отдельное подписанное
назначение рабочего канала `FLUXMODCHANNEL1` не меняет выпуск; PostgreSQL16 и
MariaDB11 прошли Store/каналы; открытое окно удерживает обычное обновление до
кнопки. Исключения отзыва/отката/прав прекращают недопустимую версию сразу.
Feedback хранит адресата в трёх схемах и DDL, проверяет сертификат и выпуск,
выдаёт разработчику отдельный набор полей и пакет, закрывает общие вложения,
поддерживает переадресацию/известные проблемы/«У меня тоже», обезличенные
счётчики с офлайн-очередью и исправление через доступный Store выпуск.

До исходной реализации: 14 локальных наборов и tsc зелёные; исходный CI SHA
0cc93e91 — пять workflows зелёные, включая Windows. Сейчас: Store UI44
(20 снимков обе темы/glass/solid, /tmp/flux-final-store), feedback HTTP47,
feedback UI обе solid-темы, promotion с concurrency и мутациями зелёные.
Семь мутаций feedback дали ожидаемые ошибки и после восстановления полный
набор зелёный (/tmp/flux-feedback-mutations-summary.log). Последний общий
прогон: 23 набора, один сбой publishing из-за скрытия неверной SQL-строки;
исправлено без ослабления проверки: publishing снова50/50.

Осталось: UI-проверки немедленного отзыва/отката открытого окна; итоговые tsc,
сборки и затронутые наборы после последней правки; повторная актуализация
origin/studio/stage-2 и origin/main, push без force, CI текущего SHA, обновление
описания PR139 и удаление этого файла. Вручную Windows/Electron не проверялись.
