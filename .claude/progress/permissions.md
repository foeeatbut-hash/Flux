# Реестр разрешений программ, часть 1 (интернет и локальная сеть)

Задание: пункт 2 очереди `docs/roadmap/studio-next.md`; устройство — `docs/roadmap/module-api.md`,
`docs/roadmap/modules.md`, `docs/methodology/03-programs/modules.md`. Решения руководителя:
реестр `modules/permissions/registry.ts`; манифест `permissions: [{kind: internet|lan, does}]`
(договор v3); `flux.net.fetch(url, init)` — перегрузка, новое сообщение моста, проверка всех адресов
в главном процессе; согласие через Store, строки заметные; Studio — типы и проверка перед отправкой.

- Ветка: `claude/admiring-fermat-tad55v` (PR #165). Старт: 01917590 (origin/main 24f25d90).
- Файл `studio-queue.md` не трогать.

## Шаги

- [x] 1. Реестр, схема манифеста, строки/разница/отпечаток, окно установки, разница владельца + проверки модели и схемы.
- [x] 2. Перегрузка `flux.net.fetch`, сообщение моста, проверка адресов в главном процессе + проверки на локальных серверах.
- [x] 3. Studio (типы, проверка перед отправкой) и документы; снимки окна установки в обеих темах.

## Проверки «до» (наборы `modules studio`, без Chromium и dist-studio)

54 набора, провалено 3 — все среда: test-modules-restart-ui, test-modules-store-ui (нет chromium),
test-studio-electron-start (нет dist-studio). Другие — зелёные.

## Где остановился

Все три шага сделаны. Шаг 3: типы `flux.d.ts`, `page-net` в проверке Studio, `runNet` в запуске Studio, документы
(`module-api.md`, `modules.md`, `03-programs/modules.md`, `studio.md`), снимки окна установки (обе темы, `/tmp/permissions/shots`).
Осталось: финальный коммит с удалением этого файла, отчёт.
