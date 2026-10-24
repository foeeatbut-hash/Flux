# Ход руководителя — ветка claude/wizardly-hypatia-pv11j5, PR foeeatbut-hash/Flux#127

## В работе (исполнители, worktree)
- Документы Flux: параметры из Менеджмента/Тегов/E3Flux/Оборудования/каталога, наименования столбцов + скрытые флаги в xlsx (круг через внешний Excel), шаблоны (A сохраняет → B применяет), уведомление «данные устарели» + панель «где · было → стало» с переходом.
- Каталог: современный вид (категории, производители, поиск, карточки, страница модели, анимации), панель разработчика; страница docs/methodology/03-programs/catalog.md.

## Возобновление после обрыва
- Исполнители (worktree в .claude/worktrees/agent-<id>, ветка worktree-agent-<id>):
  - документы — agent ada4167a1e3c88c84, файл хода .claude/progress/docs-params.md;
  - каталог — agent aa8908a9d21ee4726, файл хода .claude/progress/catalog-redesign.md.
- Порядок: SendMessage остановленному исполнителю «продолжи по файлу хода»; если нельзя — новый flux-executor с заданием «продолжи по <файл хода> в worktree <путь>», сначала git log его ветки.
- Принятые коммиты исполнителей переносить cherry-pick в claude/wizardly-hypatia-pv11j5 и пушить пачкой.

## Очередь
1. Все выборы файла/папки и сохранения — через внутренний Проводник Flux (ImportFileChooser настройка explorer_file_picker, saveToWindows и ~20 мест скачивания, dialog.showOpen/SaveDialog в electron/main.ts и electron/filesystem/ipc.ts; исключения обосновать).
2. Оборудование: панель данных (EquipmentDetailPanel, BlockCard, EquipmentUnitOverview) — компактнее, легче, информативнее, упорядочить.
3. Финальный полный аудит всех программ (включая Почту): клики, кнопки, вид, логика, удобство; исправить.

## Принято и отправлено
XML-импорт в одном окне, группы 001ABC (+ревизия B), пути установок; 5 правок тегов/оборудования; 9 правок офиса/Проводника (сетка дальше Z, формулы); каскад удаления проекта.

## Стенд
Сервер: PORT=3100 FLUX_TEST_LICENSE=1 FLUX_TEST_LICENSE_AUTO=1 npx tsx server.ts; вход Tester/1122 (создан в database/database.sqlite).
