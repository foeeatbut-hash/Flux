# departments-1 — Подразделения, этап 1 (справочник и распределение)

Задание: docs/departments.md (разделы 3, 6, 8 этап 1, 9). Ветка claude/upbeat-euler-tawcnv, старт 82f2081.
Чужие файлы (не трогать): electron/displays.ts, electron/main.ts, WindowsLayer.tsx, displayStore, workspace/displays.ts, diagnostics/contracts.ts, test-displays-native, test-windows-layer-geometry, fixtures/remaining-shell.

## Шаги
- [x] 1. Модель на трёх СУБД (schema x3, localSchema, departmentsSchema/userProfileSchema)
- [x] 2. Сервер: server/departments.ts, departmentsMatch.ts, usersImportDepartments.ts, routes/departments.ts, server.ts, actionWords
- [x] 3. Сотрудник и импорт на сервере (users.ts)
- [x] 4. scripts/test-departments.ts (96 проверок, зелёный)
- [ ] 5. Клиент: dataService, вкладка «Подразделения», колонка/фильтр/массовый перевод в «Списке», карточка, импорт, мастер
- [ ] 6. UI-снимки в обеих темах (порт 3300) -> scratchpad dep-*.png
- [ ] 7. Проверки: tsc, run-checks users departments schema architecture
- [ ] 8. Документы: 03-programs/users.md, раздел «Статус» в departments.md

## Заметки
- Базовые проверки «до» (users schema architecture): 5 из 8 зелёные; провалы окружения: test-schema-databases (нужны фикстуры БД), test-office-template-users-live (нет FLUX_USER), test-users-screen-ui (нет FLUX_UI_URL).
- prisma-clients пересобраны (generate) — package.json клиентов в коммиты не добавлять.
