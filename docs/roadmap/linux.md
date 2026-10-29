# Flux на Linux

Статус: идея · обновлено 29 октября 2026

Та же программа на Linux, без переписывания: общий код остаётся одним, а
заменяется только тонкий слой, завязанный на Windows.

## Что уже есть в программе

- Интерфейс (React), встроенный API (Express), база (Prisma: SQLite,
  MariaDB, PostgreSQL), импорт, теги, спецификации, ВДР не привязаны к ОС.
  Они уже работают на Linux: проверки CI и запись демо-видео
  (`scripts/demo-video/`) идут на Linux.
- Сборка portable уже выполняется на Linux под Windows
  (`scripts/prepare-win-native.cjs`, цель `win` → `portable` в
  `package.json`).
- Часть кода уже различает ОС: архиватор `7z.exe`/`7zz`
  (`server/archive/engine.ts`), хранение секретов почты через `safeStorage`
  Electron (`server/mail/secret.ts`: на Windows — DPAPI, на Linux — хранилище
  ключей системы).

## Что завязано на Windows

| Часть | Где | Что сделать на Linux |
|---|---|---|
| Проводник как Windows 11: диски, `%USERPROFILE%`, сеть, корзина, места | `electron/filesystem/` | реализация тех же вызовов для Linux (домашняя папка, монтирования, корзина freedesktop) |
| Интеграция с рабочим столом, окна и мониторы | `electron/desktopShell.ts`, `nativeShellHost.ts`, `nativeDesktopRunner.ts`, `displays.ts` | облегчённая версия или отключение |
| Уведомления Windows | `electron/windowsNotifications.ts` | уведомления Electron/freedesktop |
| Привязка лицензии к машине | `electron/license.ts` | не нужна, если лицензию уберут ([license-removal.md](license-removal.md)) |
| Применение обновлений | `electron/applyUpdate.ts`, `server/routes/updateCampaigns.ts` | замена файла AppImage вместо exe |
| Сборка | `package.json` → `build.win` | добавить цель `linux` (AppImage или deb) |
| E3 | `e3/`, COM | **на Linux невозможна:** E3 — программа Windows. Остаётся работа через компьютер или виртуальную машину с Windows |

## Этапы

1. Собрать AppImage как есть и составить список того, что не запускается.
2. Убрать слой Windows за общий интерфейс там, где его ещё нет, с
   реализациями для Windows и Linux. Общий код не меняется.
3. Linux-реализации: Проводник, уведомления, обновления.
4. На Linux недоступные функции (E3) скрываются с пояснением.
5. CI на Linux для сборки AppImage рядом с Windows CI.

## Вопросы владельцу

1. Linux у пользователей или только на сервере? Если нужна только общая
   база на Linux, она уже работает (MariaDB/PostgreSQL).
2. Какой дистрибутив: Astra Linux, РЕД ОС, Ubuntu? От этого зависят формат
   пакета и проверка.
3. Нужна ли на Linux работа с E3?

## Внедрено

Пока ничего.
