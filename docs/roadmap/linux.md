# Flux на Linux

Статус: возможное развитие — **не внедряется сейчас**, продумано на будущее · обновлено 29 октября 2026

Та же программа на Linux, без переписывания: общий код остаётся одним, а
заменяется только слой, завязанный на Windows.

## Что работает без изменений

- Интерфейс (React), встроенный API (Express), база (Prisma: SQLite,
  MariaDB, PostgreSQL), импорт, теги, спецификации, ВДР, Конструктор,
  Каталог. Проверки CI и запись демо-видео (`scripts/demo-video/`) идут на
  Linux.
- Flux Office (GenOffice) — веб-редакторы, а не нативные: собираются
  `tools/genoffice/build.mjs` в `public/genoffice/<app>/`, серверная часть —
  `genoffice-server/<app>.cjs` в worker. Работают на Linux как есть.
- Нативный модуль один — `better-sqlite3`; остальные зависимости — чистый
  JS (адаптеры mariadb/pg, exceljs, imapflow).
- Уже с ветками по ОС: `electron/displays.ts` (win32 и linux),
  `electron/authStorage.ts` (`safeStorage`, на Linux с проверкой
  хранилища), `electron/filesystem/replace.ts` (на не-Windows — `rename`),
  `server/mail/secret.ts`, `electron/license.ts`.
- Уже отключается на не-Windows: `electron/desktopShell.ts` («unsupported»),
  `electron/windowsNotifications.ts`, `filesystem/nativePlaces.ts` (пусто),
  `filesystem/network.ts` (false/null).

## Что завязано на Windows

| Часть | Где | На Linux |
|---|---|---|
| Оболочка Windows: миниатюры, Быстрый доступ, облака, «Открыть с помощью», контекстное меню, корзина | `electron/nativeShellHost.ts` + `nativeShellSource.ts` (C#, собирается `Add-Type` через `powershell.exe -STA`, долгоживущий процесс с JSON) | **переписать**: миниатюры — freedesktop thumbnails или свои, корзина — спецификация freedesktop Trash, «Открыть с помощью» — `xdg-mime`/`gio`, Быстрый доступ — свой список |
| Рабочий стол Windows | `electron/nativeDesktopRunner.ts` + `nativeDesktopSource.ts` (C# через PowerShell) | не переносится; оставить отключённым |
| Уведомления | `electron/windowsNotifications.ts` + `tools/windows-notification-bridge` (C# WPF, net8.0-windows) | `Notification` Electron (libnotify) |
| Тома, сеть, корзина в Проводнике | `filesystem/nativePlaces.ts`, `network.ts` (PowerShell, WMI, `net.exe`, `explorer.exe`) | `/proc/mounts`/`lsblk`, смонтированные SMB/NFS, Trash |
| Пути и запускаемые файлы | `filesystem/paths.ts`, `service.ts:109,147` (регистр путей), `runnable.ts` (.exe/.bat) | регистр важен на Linux; правила «что запускается» — по правам `x` |
| Архиватор | `server/archive/engine.ts:16` ищет `7zz` в `resources/archive` | в сборку кладётся только `7z.exe`/`7z.dll` — **добавить `7zz` для Linux** в `extraResources` |
| Нативный SQLite | `scripts/prepare-win-native.cjs` скачивает `better_sqlite3.node` под Electron win32-x64 | нужен prebuilt под Electron linux-x64 |
| Обновления | `electron/updateFiles.ts:7` требует `*.exe`; `applyUpdate.ts` проверяет MZ-заголовок, заменяет exe; `updateCampaign.ts:34,37` кладёт платформу в подпись устройства | AppImage: проверка ELF вместо MZ, замена файла AppImage; **выпуски разделить по платформе** — сейчас `AppUpdate.version` уникальна, двух файлов на одну версию не положить |
| Сборка | `package.json` `build.win` → `portable` x64; цели `linux` нет | добавить `linux` → AppImage (и/или deb) |
| E3 | `e3/` — чистый TypeScript, COM-моста в приложении ещё нет (есть только `tools/e3-probe/*.ps1`) | **невозможно**: E3 и COM — Windows. Функции E3 скрыть с пояснением |
| Проверки | `scripts/test-windows-*.ts`, `*-native*.ts` | остаются Windows-только; нужны Linux-аналоги для заменённых частей |

## Этапы

1. **Пробная сборка.** Цель `linux` (AppImage), `better-sqlite3` под
   Electron linux-x64, `7zz` в ресурсы. Запустить и составить список того,
   что не работает. Готово: Flux запускается, вход, проект, теги.
2. **Общий интерфейс для слоя ОС.** Там, где Windows-код вызывается
   напрямую, — интерфейс с двумя реализациями (Windows — нынешняя, Linux —
   новая). Общий код не меняется.
3. **Проводник на Linux.** Тома, сеть, корзина, «Открыть с помощью»,
   миниатюры. Самый большой этап: `nativeShellSource.ts` — 763 строки C#.
4. **Уведомления и обновления.** Уведомления Electron; выпуски с полем
   «платформа», проверка ELF, замена AppImage; кампании различают
   платформу устройства.
5. **Недоступное — скрыть.** E3, рабочий стол Windows: кнопки скрыты или
   неактивны с пояснением, без ошибок.
6. **CI.** Сборка AppImage и Linux-проверки рядом с Windows CI.

## Что может пойти не так

| Риск | Как избежать |
|---|---|
| Регистр путей: `Проект.xlsx` и `проект.xlsx` — разные файлы на Linux, один на Windows | сравнение путей через одну функцию с учётом ОС; проверки на совпадение имён |
| Права на файлы: на Linux файл может быть недоступен на чтение | понятная ошибка вместо падения |
| Выпуск обновления под Windows поставится на Linux (или наоборот) | поле «платформа» в выпуске и в подписи манифеста (этап 4) — до первого Linux-выпуска |
| Нет хранилища секретов (`safeStorage` на Linux без keyring падает в `basic_text`) | проверка уже есть в `authStorage.ts`; для почты — предупреждение пользователю |
| Шрифты: интерфейс и выгрузки PDF выглядят иначе | шрифты в сборке, проверка снимками |
| Пути вида `C:\…` и `%USERPROFILE%` в базе (общие настройки, ссылки на файлы) | при сохранении — хранить относительно корня проекта; при открытии на другой ОС — понятное сообщение |

## Порядок относительно других планов

Последним: после [license-removal.md](license-removal.md) (меньше кода с
ветками ОС) и после [offline-work.md](offline-work.md) (локальная копия —
та же SQLite, проверять один раз). Поле «платформа» в выпусках нужно
продумать заодно с выпусками модулей ([modules.md](modules.md)).

## Вопросы владельцу

1. Linux у пользователей или только на сервере? Если только общая база на
   Linux — она уже работает (MariaDB/PostgreSQL).
2. Какой дистрибутив: Astra Linux, РЕД ОС, Ubuntu? От этого — формат пакета
   (AppImage, deb, rpm) и проверка.
3. Нужна ли на Linux работа с E3 (только через компьютер с Windows)?

## Внедрено

Пока ничего.
