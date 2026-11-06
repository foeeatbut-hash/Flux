# Панель «Черновики» — передача исполнителю

Задание: docs/roadmap/drafts-panel.md (разделы «Как устроено», «Задание»
из 6 шагов, «Готово, когда»); макеты — артефакт J2TyaCfoFY7XRLneUTpXcj (листы
Main, Compact, States, Settings). Ветка drafts/panel, один draft PR в main,
коммит на шаг. Не трогать: src/components/vdr/, DocflowScreen,
src/components/docflow/, modules/, src/components/modules/.

## Сделано

- [x] Шаг 1 — fffc253: черновики Flux не выводятся на стол поверх значков
  Windows (src/components/desktop/desktopEntries.ts visibleDesktopEntries).
- [x] Шаг 2 — 63ab68b: общий источник electron/filesystem/draftIndex.ts
  (тот же, что поиск «Только черновики»), draftsList в мосте, кнопка
  src/components/drafts/DraftsButton.tsx после «Пуска» на каждом мониторе,
  Ctrl+Alt+D (electron/draftsShortcut.ts + DOM), src/store/draftsPanelStore.ts.
- [x] Исправления шагов 1–2 — 1d463d1: содержимое папки-черновика в корзине
  всплывало в источнике и в «Только черновики» (unpublishedDrafts теперь
  проверяет предков); в обычном окне (один монитор, панель задач под столом,
  Layout.tsx) панель висела на 48 px выше кнопки — место считает
  src/lib/draftsPanelFrame.ts; слой падал без ipcRenderer.on и гасил стол
  (test-taskbar-ui не открывался); стенд test-windows-explorer-ui проверял
  рамку по черновику на столе — теперь проверяет «черновик не выводится»,
  а рамку/Ctrl+A/обновление — на столе без моста оболочки (fixture
  `__showWindowsDesktop('fallback')`).
- [x] Шаг 3 — коммит «шаг 3 из 6»: полоса во всю длину
  (src/components/drafts/DraftsStrip.tsx): 150/260 px, отступ 4, шапка 34,
  фильтры типа, поиск 170, сортировка (щелчок перебирает ключ, ↓/↑), группы
  по дате с вертикальной подписью, колесо листает вбок (не пассивный
  слушатель), затухание 40 px и «‹ ›». Логика — src/lib/draftsPanel.ts
  (тип, состояние, фильтры, сортировка с закреплёнными, группы, короткое
  время, счётчик, открытые окна, свободное имя «Документ (2)»), настройки —
  src/store/draftsSettingsStore.ts (localStorage flux_drafts_panel, все поля
  шагов 4–5 уже есть). Плитка/строка — DraftTile.tsx, шапка — DraftsControls.tsx.

## Проверки (последний прогон, Vite 5521, chromium-1243)

tsc 0; test-architecture PASS; check-verification PASS; test-drafts-view (8),
drafts-source, drafts-store, drafts-desktop, drafts-panel-ui, taskbar-ui —
PASS. run-checks drafts desktop taskbar explorer windows-files glass:
33 набора, провалы только прежние: desktop-creation-ui (ждёт заголовок
«Проводник» — сломан до ветки), office-explorer-live, remaining-files-explorer-api,
windows-files-electron (среда). test-windows-explorer-ui иногда падает на
случайных проверках адресной строки (Backspace, двойной щелчок по адресу) —
нестабилен и на прогоне без наших правок в Проводнике; отдельно проходит 153/0.
Отрицательные: без колеса — drafts-panel-ui падает («колесо листает полосу
вбок»); без проверки предков — drafts-source падает; старый расчёт места —
drafts-panel-ui падает (низ 700 вместо 748).

## Ловушки

- Vite в рабочей копии под .claude/** не следит за файлами (vite.config.ts
  watch.ignored): после правки перезапускать сервер, иначе проверяется старый код.
- Панель появляется с fx-rise-in (сдвиг 12 px): мерить boundingBox после ~300 мс.
- Ретчет test-architecture: shadow-lg/xl уже на пределе — тень не добавлять.
- Выбранное — fx-sel и вес 500, не зелёная заливка как в макете (01-design.md,
  раздел 3); счётчик на кнопке — нейтральный, не акцентный.
- ContextMenu — портал в body: обработчик «щелчок вне панели» в DraftsLayer
  закроет панель по щелчку в меню; исключить `[data-context-menu]` и диалоги.
- Открыть: useWindowStore.getState().open(fileRefHref(ref)) — без
  useNavigate (в стендах нет роутера).

## Осталось

- [x] Шаг 4 (сделан; коммит «шаг 4 из 6») — компактная панель (сейчас в DraftsLayer заглушка-список с
  кнопкой «Полоса»): 400 × 540 над кнопкой, ширина растёт со столбцами
  (3–6, settings.columns); шапка 36: «N из M», Плитки/Список
  (settings.compactMode), «Полоса», настройки; строка поиск + SortControl;
  фильтры типа (KindChips short) и состояния (Chip + StateDot, повторный
  щелчок снимает → settings.state); плитки — DraftTile, список — DraftRow
  (28 px, title = проект); низ 36: «Создать ▾» (createSections(pick, false)
  из src/components/files/CreatePanel.tsx, родитель — корень Desktop из
  action 'roots'), «Разобрать старые · N» (filterDrafts olderThanDays),
  «В Проводнике» (folderRefHref). Отдельный файл DraftsCompact.tsx.
- [x] Шаг 5 (сделан; коммит «шаг 5 из 6») — действия: меню правой кнопки (ContextMenu: Открыть Enter,
  Опубликовать в проект… Ctrl+P, Добавить в ВДР… — отключено с подсказкой
  «после публикации»: VDR.fileNodeId серверный, draftId подставлять нельзя;
  Закрепить первым → settings.pinned; Переименовать F2 → action 'rename';
  Показать в Проводнике; Свойства Alt+Enter → fileRefHref(ref,{properties:true});
  Удалить Del → action 'trash', корзина Flux). Публикация перетаскиванием:
  своя MIME (например application/x-flux-draft) в DraftItemHandlers.dragStart;
  в src/components/files/useExplorerOperations.tsx drop() — ветка для неё,
  подсветка «опубликовать сюда» у строк-папок ContentsPane.tsx (дерево NavPane
  сейчас перетаскивание не принимает); подтверждение «что → куда» с галочкой
  «Оставить копию»: без копии — action 'move' в папку + 'publishDraft'; с
  копией — 'copy' (carryMeta) + 'publishDraft' копии; EEXIST при move —
  numberedName(name, 2…); publishDraft только в исходную папку, поэтому
  сначала перенос. Наружу (стол/Проводник Windows) не вытаскивать —
  предложить опубликовать (мост и так запрещает внешний DnD черновиков).
  Сведения при наведении 500 мс (handlers.hover; thumbnail для картинок,
  состояние, проект/тег, даты, размер). Напоминание «N старше K дней —
  Разобрать / Позже» (settings.remindDays, kept, snoozeUntil); «Разобрать» —
  компактная панель с фильтром старых и «опубликовать/удалить/оставить все».
  Настройки (шестерёнка, лист Settings) — все поля есть в draftsSettingsStore;
  счётчик DraftsButton перевести на badgeCount(settings.badge); открытие
  наведением (settings.openOn); closeOutside; «Правится» — openDraftIds по
  адресам окон (Native Office: owner=webContents, «открыт» ≠ «изменён»).
- [ ] Шаг 6 — замер (01-design.md раздел 8) и снимки обоих видов: светлая,
  тёмная, без прозрачности (снимки полосы для сверки: /tmp/drafts-panel/
  strip-*.png в контейнере — пересоздать); раздел о панели в
  docs/methodology/03-programs/shell.md; «Внедрено» в roadmap; удалить этот
  файл хода; Windows CI (.github/workflows/verify-drafts-panel.yml), несколько
  мониторов и 125 % — вручную владельцем.

## Состояние после шага 4

Компактная панель (DraftsCompact.tsx), мутации в scripts/check-drafts-panel-mutation.ts (таблица), фикстура-мост scripts/fixtures/drafts-panel.tsx. Файлы шага 5 уже написаны, но не подключены: draftsOps.ts, draftMenu.tsx, DraftDetails.tsx, DraftPublishDialog.tsx, DraftsSettingsPanel.tsx, DraftsReminder.tsx; Layer-версия с ними — /tmp/drafts-step4/DraftsLayer.next.tsx (если потеряна — собрать заново по списку в «Осталось»). Снимки: scripts/_shots-drafts.ts (не коммитить).

## Состояние после шага 5

Готово всё по шагу 5; мутации все падают как положено (scripts/check-drafts-panel-mutation.ts, 14 штук); tsc, architecture, drafts-*, taskbar, explorer, windows-files, glass зелёные кроме трёх прежних средовых (office-explorer-live, remaining-files-explorer-api, windows-files-electron). Остался шаг 6: раздел shell.md и «Внедрено» уже написаны (проверить), снимки обоих видов в трёх режимах (scripts/_shots-drafts.ts, не коммитить), удалить этот файл, push, описание PR #137.
