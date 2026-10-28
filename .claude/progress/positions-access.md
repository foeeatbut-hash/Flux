# positions-access — должности и уровень доступа

Задание: разделить должность (основная + дополнительные) и уровень доступа
(OWNER / ADMIN / сотрудник); убрать «главного администратора»; справочник
должностей перенести из Настроек в «Сотрудники» (вкладка «Должности»); убрать из
Настроек «Роли сотрудников» и «Документооборот»; docs users.md/settings.md.
Решения руководителя — в тексте задания (пп. 1–6).

Ветка: worktree-agent-ac444dde6c3aad90a. Ревизия старта: 40289d1 (origin/main). Порты 3311 / 5311. Не пушить.

## Шаги
- [x] 1. shared/positions.ts, схема (3 prisma + userProfileSchema + localSchema), server (права должностей, stamp, /api/roles, users, импорт)
- [x] 2. Клиент: roles.ts, SettingsScreen, UsersManagement + components/users/*
- [ ] 3. Новый набор scripts/test-positions.ts (правила пп. 2–4)
- [ ] 4. Снимки вкладки «Должности» и карточки, обе темы
- [ ] 5. Доки users.md / settings.md
- [ ] 6. Итоговые проверки и отчёт

## Проверки «до» (run-checks users departments owner schema permission role access auth)
22 набора, 5 провалов — все среда: test-access-safety-live, test-office-template-users-live (нет FLUX_USER/PASS),
test-departments-ui, test-users-screen-ui (нет Vite), test-schema-databases (нет Maria-фикстуры).

## Заметки
- Клиенты Prisma сгенерированы в самой копии (prisma-clients/*, в git не входят); package.json клиентов помечены skip-worktree.
  Основному каталогу /home/user/Flux/prisma-clients нужен `prisma generate` по трём схемам, иначе positionCode неизвестен клиенту.
- userCan в server.ts (sync) читает только личные права, без должностей — как и было.
