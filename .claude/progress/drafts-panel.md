# Панель «Черновики» — передача

Ветка `drafts/panel`, один PR в `main`: https://github.com/foeeatbut-hash/Flux/pull/137
(draft). Без force-push и rebase: перед push — `git fetch`, `git merge origin/drafts/panel`
и `git merge origin/main`. Коммитов `Co-Authored-By` с названием модели в тексте
продукта и описания PR быть не должно (правило CLAUDE.md).

## Цель

Черновики Flux (файлы и папки, созданные во Flux и ещё не отображённые в Windows)
уходят с рабочего стола в панель на панели задач: не перекрывают значки Windows,
публикуются в проект, видно состояние, старые предлагается разобрать.
Задание, меры, поведение, «Готово, когда» — `docs/roadmap/drafts-panel.md`.
Макеты (утверждены владельцем 5 ноября 2026) — артефакт
https://claude.ai/artifact/J2TyaCfoFY7XRLneUTpXcj (листы Main, Compact, States,
Settings). Страница программы — `docs/methodology/03-programs/shell.md`, раздел
«Панель «Черновики»» (меры, действия, настройки, проверки).

## Что сделано (шаги 1–6)

| Шаг | Что | Коммит |
|---|---|---|
| 1 | Черновики Flux не выводятся на стол (`src/components/desktop/desktopEntries.ts`, `visibleDesktopEntries`) | fffc253 |
| 2 | Общий источник `electron/filesystem/draftIndex.ts` (тот же, что «Только черновики»), мост `draftsList`, кнопка `DraftsButton.tsx` после «Пуска», `Ctrl+Alt+D` (`electron/draftsShortcut.ts` + DOM), `src/store/draftsPanelStore.ts` | 63ab68b |
| 1–2, правки | Корзина папки-черновика, место панели в обычном окне (`src/lib/draftsPanelFrame.ts`), слой без `ipcRenderer.on` | 1d463d1 |
| 3 | Полоса: `DraftsStrip.tsx`, `DraftsControls.tsx`, `DraftTile.tsx`, логика `src/lib/draftsPanel.ts`, настройки `src/store/draftsSettingsStore.ts` (localStorage `flux_drafts_panel`) | b00106c |
| 4 | Компактная панель `DraftsCompact.tsx` (3–6 столбцов, список 28 px, фильтры типа и состояния, низ «Создать / Разобрать старые / В Проводнике») | 054f6ab |
| 5 | Меню и клавиши (`draftMenu.tsx`, `draftsOps.ts`), публикация перетаскиванием (`src/lib/draftsActions.ts`, `src/store/draftsPublishStore.ts`, `DraftPublishDialog.tsx`; ветка в `useExplorerOperations.tsx` `drop()`, `data-entry-kind` в `ContentsPane.tsx`, приём в `NavPane.tsx` и `ExplorerTabs.tsx`), сведения `DraftDetails.tsx`, напоминание и разбор `DraftsReminder.tsx`, лист настроек `DraftsSettingsPanel.tsx`, `hint`/`title` в `ContextMenu.tsx`, подсветка `[data-draft-drop]` в `src/index.css` | a3202c1 |
| 6 | Раздел в `shell.md`, «Внедрено» в roadmap, статус в `docs/roadmap/README.md` | ef12976 |
| CI | Починка красного CI (см. ниже) | 37dc753 |

Слой, который всё собирает, — `src/components/drafts/DraftsLayer.tsx` (смонтирован в
`WindowsLayer.tsx`). Вся логика отбора без React — `src/lib/draftsPanel.ts`,
публикация без React — `src/lib/draftsActions.ts`.

Как работает публикация перетаскиванием: без копии — `move` черновика в папку
назначения и `publishDraft`; с копией — `copy` (`carryMeta`) и `publishDraft` копии
(мост публикует только в исходную папку, поэтому сначала перенос). Занятое имя:
`EEXIST` от моста → `numberedName` «(2)», «(3)». Цель — только настоящая папка
Windows; папка-черновик отклоняется. Отпустили мимо папки — тост (наружу не
вытаскивается).

## Что осталось

1. **CI на PR #137 зелёный на последнем SHA** (см. «Состояние CI»); три прежних
   красных job разобраны ниже.
2. **Windows вручную владельцем**: несколько мониторов (панель на мониторе, где
   нажали; полоса в его ширину) и масштаб 125 % — в контейнере не проверить.
   Workflow `.github/workflows/verify-drafts-panel.yml` проверяет только один монитор.
3. **«Добавить в ВДР…»** — пункт отключён («доступно после публикации»).
   PR #138 ещё не влит; будущая связь — `DocFileLink` через `/api/docflow/links`
   после его слияния и публикации файла в проект. Это отдельная задача.
4. **«Правится» у коллеги и «изменён»** — состояние считается только по адресам
   окон этого Flux (`openDraftIds`, `draft=…`); коллеги и Native Office не учтены,
   открытие не доказывает изменение. Серверный roster Office привязан к `fileId`,
   универсального соответствия локальным черновикам нет. `office:join` регистрирует
   участника и может назначить держателя; пассивного API для панели нет.
5. **Меню черновика — восемь пунктов**, правило `os-design.md` §4.4 «не длиннее
   семи» нарушено сознательно: владелец утвердил состав; оговорка записана в
   `shell.md`.
6. После Windows-проверки владельцем — удалить `docs/roadmap/drafts-panel.md` по
   правилу `docs/roadmap/README.md` (план целиком внедрён), строки в README
   roadmap убрать, ссылку оставить в `docs/plan.md`; удалить этот файл.
7. Не сделано осознанно: выбор нескольких черновиков (выбор в панели одиночный);
   публикация без выбора папки идёт через окно выбора `useFluxSaveStore.pickFolder`.

## Нюансы и ловушки

- Vite в рабочей копии под `.claude/**` не следит за файлами (`vite.config.ts`
  `watch.ignored`): после правки перезапускать сервер, иначе проверяется старый код.
- Интерфейсный стенд панели — неизменяемая сборка:
  `node --import tsx scripts/build-drafts-fixture.ts` (~30 с) → `.cache/drafts-ui`,
  раздаёт `scripts/serve-drafts-fixture.cjs` на 5395. В стенде настоящие `ContentsPane`
  и `useExplorerOperations` (миниатюра Проводника), мост подменён в
  `scripts/fixtures/drafts-panel.tsx` (`move`, `copy`, `publishDraft`, `trash`,
  `rename`, `roots`, `createDraft*`).
- В `page.evaluate` нельзя объявлять именованные стрелки (`const f = () => …`):
  tsx добавляет `__name`, которого нет в странице. Помощники — в `window.__drafts`.
- Панель появляется с `fx-rise-in` (сдвиг 12 px): мерить `boundingBox` через ~300 мс.
- Выбранное — `fx-sel` и вес 500 (не зелёная заливка); счётчик на кнопке нейтральный;
  `font-semibold` здесь 550 — для заголовков `font-[600]`; метка типа на значке —
  часть рисунка (8 px допустимо).
- `shadow-lg/xl` в ретчете `test-architecture` на пределе — тень не добавлять.
- `ContextMenu` и диалоги — порталы в `body`: «щелчок вне панели» и `Esc` в
  `DraftsLayer` исключают `[data-context-menu]` и `[role="dialog"]`.
- Плитка может оказаться под неподвижным курсором после удаления соседней —
  `pointerenter` придёт только при движении мыши; тосты могут лечь поверх плиток.
  Карточка сведений снимается, когда черновика нет в источнике (слой).
- Источник обновляется по событию моста с паузой 100 мс: в проверках ждать
  обновления списка, а не появления баннера.
- `prisma-clients/*/package.json` меняет `scripts/session-start.sh` — не коммитить.
- Стенд значков `scripts/fixtures/icons-shell.tsx` больше не держит черновик на столе.

## Наборы проверок

Быстрые (без браузера): `test-drafts-view`, `test-drafts-actions`,
`test-drafts-source`, `test-drafts-store`, `test-drafts-desktop`,
`test-architecture`, `check-verification` (манифест `verification/manifests/shell.json`).
Интерфейс: `test-drafts-panel-ui` (стенд 5395, `FLUX_UI_URL`, `FLUX_CHROME`),
`test-taskbar-ui`, `test-windows-explorer-ui`, `test-icons-shell-ui` (Vite).
Запуск области: `node_modules/.bin/tsx scripts/run-checks.ts architecture drafts
taskbar explorer windows-files glass verification`.

Мутации (`scripts/check-drafts-panel-mutation.ts`, таблица `MUTATIONS`, 15 штук;
`ONLY=имя,имя` выбирает): button, columns, state-filter, review, pin, hover-delay,
explorer-drop, drop-setting, stale-hover, snooze, close-outside, drop-highlight,
name-retry, keep-copy, pinned-group. Каждая обязана уронить набор на названной
проверке. На последнем прогоне все 15 упали как положено (по частям, в разных запусках).

Падают из-за окружения (не из-за ветки): `test-office-explorer-live`,
`test-remaining-files-explorer-api` (нужна метка live-стенда),
`test-windows-files-electron` (настоящий Electron/IPC), `test-desktop-creation-ui`
(ждёт заголовок «Проводник», сломан до ветки; в выбранные наборы не входит).

## Состояние CI (PR #137)

Продолжение 6 ноября 2026: на `3a8264c` все workflow, кроме `office-native`,
зелёные. Первая причина `office-native` — финальная проверка
`test-office-explorer-live`: неожиданный 409 от `office-local/write-state`.
Этот маршрут возвращает 409 при несовпадении `baseHash` и хеша присланных байт;
тела ответа в прежнем журнале нет. На `37dc753` оба полных прогона этого job
прошли. Повтор только упавшего job запущен; результат для нового HEAD смотреть
в checks PR, не переносить успех прежнего SHA на новую ревизию.

Локальный сценарий `FLUX_NATIVE_ONLY=local-panel` прошёл до изменений и после
добавления диагностики. В журнале следующего конфликта будут маршрут, хеши и
ошибка сервера без байтов документа; защита записи и проверки не ослаблены.
Новых проверок не добавлено. `tsc` — 0; 14 быстрых наборов области и
`test-office-local` — зелёные. Полный `npm run check` не запускался: нет общего
API/UI-стенда; ограничения прежней передачи остаются в силе. Ручная проверка
Windows (несколько мониторов, 125 %) по-прежнему за владельцем.

На SHA ef12976 было три красных job:
- `drafts-windows` (job 127663484902): мутация `explorer-drop` падала не на
  `waitFor`, а раньше — на проверке карточки сведений (в списке осталась карточка
  удалённой плитки `Схема П1.pdf`; на Windows она успевала появиться до удаления).
  Причина: продукт (карточка не снималась при исчезновении плитки) + тест (зависел
  от неподвижного курсора и не ждал обновления списка). Починено в 37dc753.
- `contracts` (job 127663484786): `test-icons-shell-ui`, «Стол: «Заметки.md» — вид
  «markdown» 0». Причина: тест/стенд — строка с индексом 6 в стенде была черновиком
  Flux (`storage: 'flux'`), а шаг 1 убрал черновики со стола. Починено в 37dc753
  (все строки стенда — файлы Windows).
- `modules-windows` (job 127663485377): `test-modules-flux-ui-live.ts:106`,
  `locator('input').nth(0).fill` — таймаут 15 с на входе полного Flux в Electron.
  Это не область панели; предыдущий прогон на b00106c был зелёный, прогоны
  Studio — зелёные. Вероятно, медленный запуск на Windows-раннере; смотреть по
  перезапуску на новом SHA, при повторе — разбирать отдельно (не чинить в панели).

Итог CI на 37dc753 (после починки): `drafts-windows` (оба прогона), `contracts`,
`modules-windows`, `windows-shell`, `security-db`, `remaining-api-fixture` — зелёные;
`modules-windows` прошёл без правок в модулях, то есть красный на ef12976 был
разовым сбоем запуска Electron на раннере. `office-native` на момент записи ещё
шёл (в красных на ef12976 не числился). Последний коммит после 37dc753 — только эта
передача (документы), CI по нему проверять тем же списком job. Локально на 37dc753:
`test-drafts-panel-ui` зелёный, мутации `stale-hover` и `explorer-drop` падают как
положено, `test-icons-shell-ui` 70/0, остальные наборы job `contracts` после него
(`import-file-chooser`, `chat-*`, `owner-login`, `remaining-*`, `guide-*`,
`office-addon`) — зелёные.
