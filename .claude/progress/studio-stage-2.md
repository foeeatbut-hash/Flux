# Flux Studio, этап 2 «Распространение» — файл хода и передачи

Для исполнителя без контекста. Сначала прочти этот файл целиком, потом
`CLAUDE.md`, затем только нужные разделы плана.

**Задание:** `docs/studio-handoff.md`, раздел 2, строка «2. Распространение»,
шаги (а)–(г); план — `docs/roadmap/modules.md`: «Запрос на публикацию и
проверка владельцем», «Цепочка доверия», «Пакет модуля», «Публикация»,
«Flux Store», «Ошибки и предложения по подпрограммам».

**Ветка** `studio/stage-2` (push без force), старт от `origin/main` 0beb4d6.
Draft PR в `main` открыт из этой ветки.

## Шаги
- [x] 1. Ядро доверия `modules/trust/` + `test-modules-trust` — 2d4518c
- [x] 2. Таблицы на трёх СУБД, сервер: запросы, решения владельца, выпуски, отзывы, сертификаты — 92bf8e1
- [x] 3. Клиент: проверка и кэш в главном процессе, протокол из кэша, подпись владельца — 8edc33a
- [x] 4. Раздел владельца «Запросы на публикацию» — e5f1451
- [x] 5. Документы и этот файл (шаг (а) закрыт)
- [ ] (б) права, роль «Разработчик», каналы, откат — НЕ начат
- [ ] (в) Flux Store — НЕ начат
- [ ] (г) ошибки и предложения по подпрограммам — НЕ начат

## Как устроено (шаг а)

### Подписанные записи — `modules/trust/`
| Файл | Что |
|---|---|
| `envelope.ts` | `ПРЕФИКС.<b64url(канонический JSON)>.<b64url(Ed25519)>`; префиксы `FLUXMOD1` выпуск, `FLUXMODREQ1` запрос, `FLUXMODCERT1` сертификат, `FLUXMODREV1` отзыв. `canonicalJson`, `sealEnvelope`, `openEnvelope` (проверка), `peekEnvelope` (без проверки). Только Node. |
| `claims.ts` | Поля каждой записи и строгий разбор (лишнее поле — недействительно). Куски по 256 КиБ, пакет ≤ 32 МБ, каналы `test`/`production`. Без зависимостей (берёт и окно). |
| `bundle.ts` | Пакет = канонический JSON `{"files":{путь: base64},"v":1}`; `packBundle`/`unpackBundle` (неканонический отвергается), пути без `..`; `build/runtime.js` — то, что запускается. Без зависимостей. |
| `verify.ts` | `verifyRelease` (подпись корня → строка таблицы → отзывы → время → sha256 кусков и пакета → manifest → runtime.js), `verifyRequest`, `readRevocations`, `readCertificates`, `checkChunks`. |
| `diff.ts` | Разница по файлам (LCS по строкам) и по разрешениям (`reads`, `entries`, `connections`). Не хранится: считается из двух пакетов (запрос подписан вместе с `baseRelease`). |
| `owner.ts` | Что подписывает владелец — главный процесс строит описание сам из байт пакета (выпуск, правка владельца, отзыв, сертификат). |

### Ключи
- **Корень** — ключ издателя обновлений `electron/updateKey.ts`
  (`UPDATE_PUBLIC_KEY_HEX`), в хранилище владельца это `keys.update`.
  Отдельного ключа модулей нет: подписи не спутать за счёт префикса. Если
  владелец захочет отдельный ключ — добавить `keys.module` в
  `tools/flux-owner/src/vault.cjs` и заменить `MODULE_ROOT_KEY_HEX`
  (`server/moduleStore.ts`) и ключ в `electron/modules.ts`, `electron/moduleSigning.ts`.
- **Разработчик** — свой Ed25519; сертификат (`FLUXMODCERT1`, подпись корня)
  привязывает ключ к профилю (`userId`). Запрос принимается, только если
  ключ из действующего сертификата и профиль совпадает с вошедшим.
  Правка владельца — запрос с автором = корень.
- Хранение ключа разработчика в Studio (`safeStorage`) — этап 4; сейчас
  клиента-отправителя нет, только API (`POST /api/modules/requests`).

### Таблицы (три схемы `prisma/schema*.prisma`, создаёт `schema-sync`)
`ModuleRequest` (неизменяемый запрос; `signatureHash` уникален — повтор не
плодит строк; `state`: writing → pending → returned | rejected | edited |
superseded | released), `ModuleRelease` (`@@unique([moduleId, version])`,
`blobId` = id запроса — куски не копируются), `ModuleChunk`
(`@@unique([blobId, idx])`), `ModuleCertificate` (`keyHex` уникален),
`ModuleRevocation` (`signatureHash` уникален).

### Маршруты — `server/routes/modulePublishing.ts` (подключён из `server/updates.ts`; server.ts не тронут)
- `POST /api/modules/requests` `{signature, bundle(base64)}` — разработчик или владелец (правка, `parentRequest`).
- `GET /api/modules/requests[/:id[/bundle|/diff]]` — владелец всё, разработчик своё.
- Владелец: `POST …/:id/return {note, comments[]}`, `…/:id/reject {reason}`, `…/:id/release {signature}`, `POST /api/modules/revocations`, `POST /api/modules/certificates`.
- Все вошедшие: `GET /api/modules/releases`, `GET /api/modules/releases/:id/chunks`, `GET /api/modules/revocations`, `GET /api/modules/certificates` (не владелец — свои).
- Сервер сверяет подписи при приёме, но доверие — только на клиенте.

### Клиент — где проверка подписи
- `electron/moduleCache.ts` (без electron, проверяется скриптом): кэш `userData/modules/releases/<id>/<ver>/{release.sig,bundle.bin}` + `revocations.json`. Каждое чтение перепроверяет подпись и куски; отзывы только добавляются; держит 3 проверенные версии; `runnable(channels)` — новейший проверенный выпуск канала (по умолчанию `production`).
- `electron/modules.ts`: протокол `flux-module://` отдаёт модуль из базы только из кэша (`runtime.js` из пакета, оболочка из `dist/modules/_shell`, её собирает `modules/build.ts`); IPC `modules:state`, `modules:sync` (окно приносит скачанное — решает главный процесс). Встроенный пример с тем же id выпуском не подменяется.
- `electron/moduleSigning.ts`: IPC `modules:sign` — файл хранилища на каждую подпись, фраза-пароль, `keys.update`, сверка с ключом сборки. Каналы добавлены в `electron/ipcAllow.ts`.
- Окно: `src/services/moduleReleaseService.ts`, раздел `src/screens/ModuleRequests.tsx` (`/module-requests`; в Пуске adminOnly, содержимое — только OWNER), `src/components/modules/{PublishRequestView,ModuleTrustPanel,OwnerSignDialog}.tsx`.

## Что проверено
- `scripts/test-modules-trust.ts` (48 проверок) и `scripts/test-modules-publishing.ts` (50; SQLite; тот же набор прошёл на PostgreSQL 16 по `FLUX_MODULES_PG_FIXTURE_URL`; MariaDB — `FLUX_MODULES_MARIA_FIXTURE_URL`, в контейнере её нет, НЕ проверено).
- Сценарии: SQL-выпуск без подписи и с подписью только разработчика не запускаются; изменённый кусок — нет, работает прошлый; отозванный ключ — нет, работает прошлый; стёртый из базы отзыв не возвращает выпуск; отозванный выпуск; повтор выпуска не плодит строк, другая подпись той же версии — 409; время выпуска; подменённый файл кэша.
- Мутации (каждая валит набор): подпись не проверяется (peek); куски не сверяются; отзыв ключа игнорируется; кэш забывает отзывы; кэш не перепроверяет диск; повтор выпуска плодит строку; сервер принимает любую подпись.
- tsc 0, test-architecture пройден; `run-checks test-modules test-schema test-security test-owner-updates test-updates` — 17 наборов, провал только test-schema-databases (нужны фикстуры MariaDB и PG, падал и до работы).
- Снимки раздела владельца в обеих темах (ответы `/api/modules` и роль подменены — войти владельцем в живом сервере нельзя): без горизонтальной прокрутки и ошибок консоли.
- НЕ проверено: Electron-часть живьём (протокол из кэша, IPC, подпись настоящим хранилищем) — нужен Electron/Windows, CI `verify-modules.yml`.

## Что осталось — конкретно
**(б) права, каналы, откат**
1. `src/lib/permissions.ts`: `module.develop`, `module.publish` (по образцу `catalog.*`, risky, по умолчанию запрещены); роль «Разработчик» — системная в `src/lib/roles.ts` + `seedRoles` (`server/routes/users.ts`).
2. Сервер: `POST /api/modules/requests` — требовать `module.develop` (передать `can` в deps, как `registerFeedbackRoutes` в server.ts; маршрут подключается в `server/updates.ts`). `module.publish` — по решению владельца (вопрос 2 плана); выпускает пока только OWNER.
3. Каналы: кому виден `test` — назначение людей; `ModuleCache.runnable(channels)` уже принимает каналы — передать каналы пользователя через `modules:state`/`modules:sync`.
4. Откат: подписанное владельцем назначение «канал → версия» (новый префикс, например `FLUXMODPIN1`). Сейчас кэш берёт новейшую проверенную версию, удаление строки из базы откатом НЕ считается — намеренно: откат должен быть подписан.

**(в) Flux Store** — по разделу плана «Flux Store»: автоматическая синхронизация (`moduleReleaseService.sync()` сейчас только по кнопке «Проверить на этом компьютере»), установка/удаление, запуск модулей из базы: секции статичны (`src/workspace/sections.tsx` строит пункты из `bundledModules`; `src/screens/ModuleHost.tsx` и `ModuleLaunchActions.tsx` ищут манифест только в `bundledModules`) — нужен общий маршрут `/module/:id` с манифестом из `modules:state`; «Вернуть предыдущую версию» (в кэше уже 3 версии), автообновление (выкл.), снимки в обеих темах.

**(г) ошибки по подпрограммам** — по разделу плана: адресат «подпрограмма» в `src/feedback/`, автоопределение по активному окну, разделение пакета, счётчики сбоев, «Исправлено в X — Обновить».

**Хвосты шага (а) для этапа 4 (Studio):** отправитель запроса (ключ в `safeStorage`, сборка `build/runtime.js` — `buildModuleRuntime` в `modules/build.ts`), сверка хеша сборки с исходниками у владельца, «Проверить в работе», замечания к строкам в окне кода, уведомление владельцу о новом запросе (сейчас только `broadcast('modules:requests')`).

## Ловушки
- Нет `strictNullChecks`: сужение по `ok` не работает, поэтому у `Verified<T>` поле `why` есть в обоих вариантах.
- Запрос и выпуск — одни и те же байты (`blobId` = id запроса). Не копировать куски и не менять пакет при выпуске.
- Время выпуска проверяется при запуске, а не при скачивании; `prune()` не удаляет выпуск «на завтра».
- `MODULE_SHELL_DIR = '_shell'` — каталог в dist, не имя модуля (имена модулей без `_`).
- Тест публикации поднимает свой express на случайном порту — `run-checks` ставит его в цепочку; сервер :3000 ему не нужен.
- Для снимков — свой сервер на порту ≠ 3000; вход OWNER по паролю закрыт, роль подменялась в ответах API (скрипт был в /tmp, в репозиторий не входит).
- После правки схем: `CLAUDE_CODE_REMOTE=true scripts/session-start.sh` перегенерирует клиентов Prisma и откатывает `prisma-clients/*/package.json`.
- Файлы Документооборота (`docflow`, `vdr`) и панель «Черновики» не трогать.
