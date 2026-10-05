# Оболочка и Flux Play

Реестр: [`verification/manifests/shell-play.json`](../../verification/manifests/shell-play.json). Он описывает найденные по исходникам действия и доступные доказательства; запись здесь сама по себе не означает успешный прогон. Сверка источников сделана для Flux 1.20.6, 4 октября 2026.

## Состояние доказательств

[`test-play-mariadb-two-api-live.ts`](../../scripts/test-play-mariadb-two-api-live.ts) прошёл на одноразовом MariaDB fixture (**37 проверок**, 4 октября 2026): два отдельных API-процесса, четыре игрока Дурака, полная партия за 139 ходов и матч Бильярда с настоящими HTTP-сессиями. Проверены личные карты, ход не по очереди, повтор ключа через второй API, устаревшая ревизия, повторный вход, результат/история и отказ посторонним. Сценарий включает Flux Play и выдаёт права только синтетическим аккаунтам fixture. [`test-remaining-shell-play-ui.ts`](../../scripts/test-remaining-shell-play-ui.ts) прошёл на Chromium component fixture: проверены основные контролы Play-компонентов, pending/error states, темы и размеры, Start menu search/navigation/pinning/footer и ошибки консоли. [`test-play-match-frame-ui.ts`](../../scripts/test-play-match-frame-ui.ts) ранее прошёл с подменённым fetch. Обе браузерные проверки используют локальные component fixtures и не подключаются к живому Play API. Фикстуры описаны в [`remaining-shell/README.md`](../../scripts/fixtures/remaining-shell/README.md).

Статус **NOT_RUN** сохраняется для полной визуальной/интерактивной матрицы живого `/play`, снимков оболочки, проверки тем и размеров окон, доступности с клавиатурой в Electron, реальных native notifications/capture/native-app окон, переноса окон между физическими мониторами и portable-прогона. Имитированные `screen`, `BrowserWindow`, filesystem bridge и notification provider подтверждают только кодовую границу и обработку фикстуры. Они не подтверждают поведение Windows Shell, Win32 DPI, реального буфера экрана или процесса Electron на Windows.

## Реестр областей и маршрутов

| Область | Маршрут/вход | Основные исходники | Состояние |
|---|---|---|---|
| Оболочка и рабочий стол | системная кнопка Пуск, Ctrl+K; отдельного маршрута нет | [`Desktop.tsx`](../../src/components/Desktop.tsx), [`StartMenu.tsx`](../../src/components/StartMenu.tsx), [`Taskbar.tsx`](../../src/components/Taskbar.tsx) | Модель частично покрыта unit наборами; живой экран NOT_RUN |
| Окна, столы и контекстные меню | окна поверх `/`; native display-workspace в Electron | [`WindowsLayer.tsx`](../../src/components/WindowsLayer.tsx), [`windows.ts`](../../src/lib/windows.ts), [`ContextMenu.tsx`](../../src/components/ContextMenu.tsx) | Геометрия и фильтрация клавиш частично unit; перенос на экране NOT_RUN |
| Уведомления | панель оболочки, настройки уведомлений Windows | [`NotificationsPanel.tsx`](../../src/components/NotificationsPanel.tsx), [`windowsNotifications.ts`](../../electron/windowsNotifications.ts) | Параметры/граница IPC проверяются тестами с подменой; реальный listener NOT_RUN |
| Захват экрана | `/capture`, вызывается импортом/обратной связью | [`App.tsx`](../../src/App.tsx), [`CapturePult.tsx`](../../src/screens/CapturePult.tsx), [`capture.ts`](../../src/feedback/capture.ts) | Особое окно вне `SECTIONS`; lifecycle и native capture NOT_RUN |
| Native application | `/native-app`, список дочерних окон в панели задач | [`NativeAppHost.tsx`](../../src/components/NativeAppHost.tsx), [`nativeApps.ts`](../../electron/nativeApps.ts) | VM component-тест с подменёнными `BrowserWindow`/`screen` проверяет IPC и lifecycle guard; реальный запуск и поведение Windows NOT_RUN |
| Стикер | `/sticker`, запускается из заметки или файлового офиса | Паспорт и исходники принадлежат группе files-office | Особое окно вне `SECTIONS`; lifecycle связь с заметкой отмечена там, NOT_RUN |
| Flux Play | `/play` | [`PlayScreen.tsx`](../../src/play/PlayScreen.tsx), [`mainAction.ts`](../../src/play/mainAction.ts), [`play/features.ts`](../../play/features.ts) | Модель и правила имеют unit/API наборы; UI NOT_RUN |

Витрина Play ограничена действующими встроенными играми `cards` (Дурак) и `billiards` (Бильярд). Архивные адаптеры и остальные игры из `play/games` не являются действиями этой программы. `/capture` и `/native-app` внесены в маршруты оболочки явно: они не входят в `SECTIONS` и не рендерят обычную рамку окна. `/sticker` принадлежит паспорту files-office.

## Паспорт действий shell

| ID | Обнаруженные способы запуска и действие | Автоматические доказательства | Ручная проверка |
|---|---|---|---|
| `shell.desktop.arrange` | Значок, двойной щелчок, сортировка, drag/drop, меню стола, переполнение | `test-desktop.ts` — unit модели клеток, сортировки, переполнения и размещения | Пустой/полный стол, узкое окно, темы и действие каждого меню — NOT_RUN |
| `shell.start.open-search` | Кнопка Пуска, поиск, Enter и переход в раздел | `test-start-menu.ts` — unit прав, групп, поиска/смены раскладки, недавних | Реальное открытие/закрытие и запуск в браузере/Electron — NOT_RUN |
| `shell.start.pin-recents` | Закрепление/открепление, изменение порядка, недавний раздел | `test-start-menu.ts` — unit порядка, лимитов и списка недавних | Сохранение после полного перезапуска и жесты мыши — NOT_RUN |
| `shell.taskbar.activate-window` | Запуск раздела, переключение окна, peek, выбор окна из группы, закрытие | `test-taskbar.ts` — unit состава/сжатия/ролей и `test-window-close.ts` — lifecycle модели | Два окна одного маршрута, фокус и закрытие в живой оболочке — NOT_RUN |
| `shell.taskbar.overflow-tray` | «Ещё», часы, звук/сеть, смена темы, уведомления и системные панели | `test-taskbar.ts` — unit подгонки значков по ширине | Узкая геометрия, фокус, popover и все действия трея — NOT_RUN |
| `shell.context.open-submenu-dismiss` | ПКМ/контекстная клавиша, подменю, выбор, Escape, внешний клик | `test-context-menu.ts` — unit положения в рабочей области фиктивного монитора | Корректный объект команды и реальное закрытие/раскрытие — NOT_RUN |
| `shell.keyboard.global-shortcuts` | Глобальный поиск, цикл окон/столов, команда закрытия; Ctrl+W/Ctrl+S и другие подсказки активного редактора | `test-hotkeys.ts` проверяет фокус/текстовые поля и активное окно; `test-desk-keys.ts` — подписки смены стола | Полная матрица сочетаний по каждому окну, столу и редактору — NOT_RUN |
| `shell.windows.move-resize-snap-maximize` | Заголовок, 8 сторон/углов, snap у края, кнопка/двойной щелчок maximize, восстановление | `test-windows.ts` — unit геометрии; новый fixture-тест — фиксированные координаты выхода за границу | DPI и физические пиксели на Windows, перемещение между мониторами — NOT_RUN |
| `shell.windows.focus-minimize-close-multiple` | Фокус/подъём, свернуть, восстановить, закрыть, повторно открыть, переключить стол | `test-window-close.ts`, `test-windows.ts`, `test-desk-keys.ts` проверяют модель и переходы | Поведение двух одинаковых окон, перезапуск и поздний native-ответ — NOT_RUN |
| `shell.desktop.native-read-open` | Переключить физический стол, обновить снимок, открыть значок Windows | `test-desktop-shell-native.ts` — component с Electron/Win32 границей подменённой; файловый capability проверяется на временных файлах | Реальные PIDL, физические значки, Windows Explorer и DPI — NOT_RUN |
| `shell.displays.workspace-mode` | Включить общий режим, показать/скрыть штатную панель Windows | `test-displays-native.ts` — component IPC/сохранения с тестовой моделью `screen` и окна | Физические 1/2/3 монитора, mixed DPI, вертикальное расположение, отключение экрана, RDP — NOT_RUN |
| `shell.notifications.internal-settings` | Открыть панель, открыть событие, параметры источника | `test-shell-notify.ts` — unit модели и переходов | Тексты, прочтение, переходы и настройки на живом экране — NOT_RUN |
| `shell.notifications.windows-consent` | Отдельное согласие, получение и показ уведомлений Windows | `test-windows-notifications.ts` — component с поддельным provider, валидацией и локальной фикстурой | Фактическое разрешение Windows listener и реальные уведомления — NOT_RUN |
| `shell.capture.lifecycle` | Запустить `/capture` из вызывающего экрана, выбрать область/отменить, вернуть результат | Автоматического сквозного набора в этой группе нет | Окно, Windows capture API, отмена и возврат в импорт/обратную связь — NOT_RUN |
| `shell.native-app.lifecycle` | Открыть `/native-app`, фокусировать/свернуть/закрыть через панель, завершить приложение | `test-native-app-windows.ts` — component: VM загружает Electron-модуль с mock `BrowserWindow` и `screen`, проверяет trusted IPC, внутренние адреса, идентичность окна, список/навигацию, экран курсора и подтверждение закрытия | Реальное окно, list/focus/close в Windows, остановка процесса и выход приложения — NOT_RUN |

Метаданные всех действий, точные ссылки и слои находятся в manifest. Наличие unit набора не означает проверки кнопки в браузере: этот пробел остаётся видимым.

В manifest отдельными паспортами также занесены команды desktop context menu: создание папки/документа/таблицы/заметки, добавление файла, два вида, масштаб, 4 варианта сортировки, обновление и запуск Проводника; меню объекта: открыть, открыть в выбранном приложении, переименовать, выгрузить в Windows, общий стол, карточка связей, свойства и убрать; группа значков: собрать/раскрыть/переименовать. Для Пуска отдельно записаны открыть раздел, закрепить/открепить на столе/панели, переставить плитку, Главная и нижние команды настроек/темы/выхода/завершения. Для окон отдельно перечислены свернуть/восстановить, maximize/snap menu и закрытие/подтверждение. У панели отдельно указаны меню открытия/нового окна/закрепления/закрытия, «Прибраться»/«Показать стол», календарь и правый dock. Все ручные сценарии этих команд пока NOT_RUN.

## Паспорт действий Flux Play

В manifest Play по отдельным ID разбиты принятие/отказ приглашения, отправка приглашения, выход/исключение, ready/start, reconnect/rejoin; для Дурака — настройка колоды/варианта, выбор и атака/защита, взять/закончить кон/сдаться; для Бильярда — прицел/сила/spin/удар, биток с руки, повтор удара и правила. Каждый ID сохраняет отдельный результат и видимый пробел UI.

| ID | Действие/состояния | Существующие доказательства | Непроверенное |
|---|---|---|---|
| `play.library-select` | Библиотека/Подготовка/История, выбор Дурака и Бильярда | `test-play-permissions.ts` + новый fixture проверяет ровно список игр | Вёрстка, карточки и узкое окно — NOT_RUN |
| `play.party.invite-accept-decline` | Выбор коллеги, приглашение, принять/отклонить, выйти/исключить | `test-play-builtin-live.ts` выполняет API-сценарий в отдельных synthetic DB/HTTP сессиях | Реальная панель UI и человеческие учётные записи — NOT_RUN |
| `play.lobby.ready-start-reconnect` | Создать лобби, ready/unready, старт, возврат, stale/reconnect | `test-play-action.ts` — unit состояний кнопки; `test-play-builtin-live.ts` — встроенная API партия двух клиентов | Потеря и возврат сетевого соединения в двух окнах — NOT_RUN |
| `play.spectator.permissions` | Переполнение игровых мест, наблюдатель, проверка скрытых данных и запрещённого хода | `test-play-lobby-capacity.ts` — API/DB с временной SQLite; `test-play-durak.ts` — model DTO; `test-play-mariadb-two-api-live.ts` — MariaDB/two API, private hands и outsider denial | Реальный браузерный ответ и попытка хода наблюдателя — NOT_RUN |
| `play.durak.match-turns` | Подкидной/переводной Дурак, ходы, добор, сдача, завершение | `test-play-durak.ts` — unit полных партий; `test-play-mariadb-two-api-live.ts` — MariaDB/two API full game, reconnect, stale и idempotency | Настоящая доска и синхронизация UI — NOT_RUN |
| `play.billiards.match-physics` | Разбой, постановка битка, удар, физика, фол, группы, восьмёрка | `test-play-billiards.ts` — unit физики/правил; `test-play-mariadb-two-api-live.ts` — MariaDB/two API, серверный удар, wrong turn, retry и завершение сдачей | Анимация, pointer control и синхронный экран двух клиентов — NOT_RUN |
| `play.history-result` | Список истории и открытие результата | `test-play-mariadb-two-api-live.ts` — обе игры: участник читает результат/историю, outsider не видит матч | Реальный переход/пустое состояние истории — NOT_RUN |

## Слои наборов и условия запуска

- `unit`: `test-desktop`, `test-start-menu`, `test-taskbar`, `test-context-menu`, `test-hotkeys`, `test-windows`, `test-window-close`, `test-desk-keys`, `test-shell-notify`, `test-play-action`, `test-play-permissions`, `test-play-durak`, `test-play-billiards` и `test-verification-shell-play`. Они не доказывают живой DOM/native UI.
- `component`: `test-displays-native`, `test-desktop-shell-native`, `test-windows-notifications` и `test-native-app-windows` загружают Electron-модуль с injected/mock границей. Последний проверяет маршрут, IPC и child-window lifecycle только на mock `BrowserWindow`/`screen`; он не требует Windows. Temporary files/state очищаются скриптом. Их evidence layer в манифесте — `component`, platform `any`.
- `api-db`: Play наборы с `playHarness` создают временную SQLite DB и удаляют её. `test-play-builtin-live` и `test-play-billiards-network-live` стартуют отдельный локальный API на динамическом порту. `test-play-durak-live` — отдельный PG-only legacy сценарий. `test-play-mariadb-two-api-live` требует private `/tmp/flux-remaining-live.json`, loopback MariaDB fixture и два его записанных API origin; он включает платформу и выдаёт Play только синтетическим сотрудникам этой disposable базы. Никогда не запускать против корпоративной базы или общего сервера.
- `component`: `test-play-match-frame-ui.ts` запускает Chromium и свой локальный Vite с подменённым fetch. Его PASS доказывает обработку поздних ответов/ошибки внутри MatchFrame fixture, но не реальную связь и не визуальную матрицу `/play`.
- `component`: `test-remaining-shell-play-ui.ts` прошёл в Chromium/Vite fixture с actual source components и local stores; callbacks и люди синтетические, backend отсутствует. Это подтверждает выбранные UI-взаимодействия, но не живую страницу `/play`.
- `browser-live`: `test-layout.ts`, `test-play-stealth-live.ts` требуют Chromium; наборы с живым Flux API дополнительно требуют строго отмеченный тестовый стенд. Полный живой `/play` UI всё ещё не проверен.

## Матрица визуального и native осмотра

Все случаи ниже **NOT_RUN** без снимка, trace или записи стенда. Это относится к полному интерфейсу приложения; PASS на изолированной MatchFrame fixture не закрывает Play матрицу. Browser zoom не подменяет DPI.

| Область | Визуальная матрица | Native/portable сценарии |
|---|---|---|
| Основная оболочка, Пуск и окна | Светлая/тёмная тема; окно 820, 960, 1100, 1280, 1440, 1920 CSS px; высоты 600/900; панель и контекстное меню в доступной области | Electron на Windows; move/resize/minimize/maximize/close, несколько окон, восстановление после перезапуска |
| Taskbar/notification tray | Узкое окно, короткие подписи, переполненный список, раскрытые панели | Штатная панель Windows видима, bounds/workArea согласованы |
| Display workspace/native desktop | Область каждого монитора и крайние/отрицательные координаты; browser bounds только предварительный осмотр | DPI 100/125/150/200%; 1/2/3 монитора, разные DPI, вертикальная компоновка, отключение активного монитора, RDP; открыть/закрыть native desktop objects |
| `/capture`, `/native-app` | Короткая/узкая высота, закрытие и повторный запуск, возврат в caller | Захват экрана и отмена, дочернее native окно и очистка при выходе; sticker↔note lifecycle принадлежит files-office |
| `/play` | Светлая/тёмная тема, окно 820/960/1280/1440, высоты 600/900; библиотека, подготовка, таблицы игры и история | Два сотрудника, наблюдатель, сетевой обрыв/возврат, секретность карт, реальный исход партии |

Размеры, критерии обрезания, фокуса, hover/disabled и снимков заданы в [общем предложении стандарта](../testing-standard-proposal-2026-10-04.md#7-внешний-вид-геометрия-и-удобство). Полная проверка браузерной матрицы требует подготовленного тестового API и Chromium; этот документ не записывает непроведённую матрицу как PASS.

## Конкретные пробелы на сегодня

1. Нужен живой browser/Electron сценарий, который связывает паспорт с фактическими кнопками, подменю и keyboard shortcuts; DOM inventory alone не доказывает достижимость/результат.
2. Визуальные проверки обоих режимов темы, короткой высоты и всех базовых ширин не запускались. Для Play также не проверялись строки длинных имён, ошибки/reconnect/stale UI и состояния без лобби.
3. Native display suites сейчас имитируют `screen`/`BrowserWindow`. Они не покрывают реальные DPI virtualization, mixed-scale координаты, Windows workArea/taskbar или unplug/hotplug.
4. `/capture` и `/native-app` выделены отдельно от маршрутов `SECTIONS`; их полный open→action→cancel/close→reopen→cleanup lifecycle пока не закреплён живым сценарием. `/sticker` проверяется в паспорте files-office.
5. MariaDB/two API gameplay теперь имеет результат из выделенной disposable базы; обычную MariaDB или корпоративный API этот прогон не затрагивает. Browser suites с внешним API здесь не запускались.
6. Shared Play API наборы доказывают серверные ограничения и синтетические сессии, но не взаимодействие реально запущенных двух окон Flux и их визуальную согласованность.
7. Static source inventory обнаруживает 106 bindings shell-контролов и 47 Play bindings. В паспорте shell 58 смысловых действий, 40 без автоматического claim; в Play 18 действий, одно без автоматического claim. Source inventory не связывает автоматически JSX binding с контрактом: эти числа показывают работу для следующей ручной/DOM сверки, а не PASS или гарантированную полноту.
