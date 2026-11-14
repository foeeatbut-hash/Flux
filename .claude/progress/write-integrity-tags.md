# write-integrity-tags — этап 0, пункты 0.3 и 0.7 (исполнитель B)

Задание: `docs/roadmap/offline-work.md` «### 0. Целостность записи», пункты 0.3 (ключ кода тега)
и 0.7 (история тега в одной транзакции с тегом). Общий ход — `.claude/progress/write-integrity.md`.
Ветка: `claude/confident-brown-fprv2v` (push туда, без force). Ревизия старта: 4a76872a.
Порт сервера 3102, Vite 5102. Схемы prisma и prisma-clients не трогать.

## Шаги

- [x] 1. Одно правило ключа (`server/tagCodeKey.ts`), заполнение + отчёт, хук в `schema-sync.ts`
- [x] 2. Все пути создания/переименования пишут `codeKey`; нарушение ключа — 409 (`duplicate`, `code`, `existing`);
      набор `scripts/test-tag-code-key.ts` и его мутации (M1 без codeKey, M2a без NFC, M2b без регистра, M3 заполнение всем)
- [x] 3. 0.7: `recordChangeSets` с клиентом транзакции, запись тега и истории — одна транзакция во всех местах
- [x] 4. Набор для 0.7 и его мутации (история вне транзакции, ошибка проглочена)
- [x] 5. tsc, run-checks до/после, страница `docs/methodology/03-programs/registry.md`, удалить этот файл

## Проверки «до» (ревизия 4a76872a)

`run-checks.ts tag equipment builder schema`: без сервера — 48 наборов, 14 провалов (нужен сервер/вход/Vite/MariaDB);
с сервером :3102 (ADMIN 9001) — 9 провалов: docflow-kit-tags-ui, equipment-dialogs-escape, builder-live
(«Нет права создавать сотрудников»), schema-databases (нет MariaDB), equipment-xml-routes-sqlite
(падает и до правок), tag-canvas-live, tag-link-live, tag-passport («Нет права создавать сотрудников»), tag-tree-live.
Живые `test-tag-code-guard` (17), `test-tag-history` (43), `test-tag-metadata-merge` (47) — зелёные.

## Где остановился

Всё сделано; остаётся удалить этот файл финальным коммитом и отчитаться.
