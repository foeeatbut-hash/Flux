# Строка 11: программы — прикрепление результатов, выбор «в тест или всем», предел хранилища, «Обновите программу»

Задание: `docs/plan.md` строка 11 очерёдности; требования — `docs/roadmap/studio-next.md`, «Ответы владельца 15 ноября 2026 перед выпуском».
Ветка: worktree-agent-a240ff215a2fd73e3 (не пушить до слова руководителя). Ревизия старта после слияния: a06a202.

## Решения руководителя (владелец не на связи — НЕ ПОДТВЕРЖДЕНО ВЛАДЕЛЬЦЕМ)

- Результат прикрепляется файлом в папку проекта в Проводнике Flux (`FileNode`, подпапка «Результаты программ / <название программы>»); проект — тот, что открыт у человека в программе; без открытого проекта — отказ с понятным текстом. Видят те же, кто видит проект. Запись — через общие пути записи файлов (журнал изменений действует: внутри транзакции писать только через клиент транзакции).
- «В тест» — версия уходит в существующую пробную группу владельца; отдельного списка тестеров у разработчика нет. Человек с уже установленной версией при выпуске «в тест» ничего не получает, пока владелец не выпустит всем.
- Предел хранилища снят полностью, мягкого порога нет.

## Шаги

- [x] 1. attach: сервер (`server/routes/moduleAttach.ts`, POST /api/modules/attach) + мост + Flux (ModuleFrame, modulePage.ts) + Studio (имитация в Run.tsx) — наборы scripts/test-module-attach-{bridge,server}.ts, мутации ещё НЕ прогнаны
- [x] 4. (код и наборы готовы) «Обновите программу»: modules/trust/verify.ts newerThanThisFlux, store/model.ts, ModuleHost.tsx
- [ ] 2. выбор «в тест / сразу всем» при отправке версии (Studio разработчика) — до сервера и владельца
- [x] 3. предел хранилища программы снят (modules/storage/model.ts NO_STORAGE_LIMIT, disk.ts, electron/moduleStorage.ts, studio/shell/runStorage.ts); наборы storage, storage-host, storage-native (xvfb, 33), studio-run-storage обновлены; run-ui обновлён, ещё не гонялся
- [ ] 5. наборы, мутации, снимки обеих тем (/tmp/u11-shots/), документы-заметки для отчёта

## Ход

- Рабочая копия подготовлена (симлинки node_modules, genoffice, prisma-clients).

- Baseline (до правок): run-checks по словам test-studio-page, test-modules-permissions, test-modules-page, test-modules-contract, test-modules-storage, test-modules-publishing, test-studio-checks — 9 наборов, провалов 0, пропущено 2 (native: нужен xvfb).
- Шаг 1 и 4: test-module-attach-bridge 44 проверки, test-module-attach-server 33 проверки — зелёные; tsc 0.
- Осталось: шаг 2 (PublishDialog), шаг 3 (предел), снимки, мутации, UI-набор, прогон области, документы для отчёта.
- Шаг 3 готов: storage 150 проверок (мутации замечены), storage-host 82, storage-native 33 (dist собран `npx vite build`, xvfb), studio-run-storage 23; tsc 0.
