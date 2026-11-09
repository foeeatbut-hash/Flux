# review-auth-security — исправления внешнего ревью (вход, сессии, права, общий слой сервера, сокеты)
Ветка fix/review-auth-security, старт e3cd01c2. Задание: scratchpad/bugv/COMMON.md + g1/g2/g3-verdict (см. сообщение руководителя).
Тесты «до»: test-office-template-users-live (нужны учётные данные), test-session-lifecycle (classList), test-users-screen-ui — падали до правок.

Шаги:
- [x] 1 authSessions: ключ отзыва (НОВОЕ-1), чистка, цена validate (30/97), 27, 29
- [x] 2-6 (код: security, cookies, auth.ts, users.ts, tags.ts, permRoutes, trustedTime, server.ts, sockets) security.ts/authCookies: 11, 13?, 15/НОВОЕ-2/14, 24, 26, 32, 33, 36, 37, 49
- [ ] 3 login (auth.ts) + хеш async: 17-23
- [ ] 4 users.ts: 52-58
- [ ] 5 server.ts: 40-46, 44/80/НОВОЕ-3 права, время 47-49, 51, 39, 12 комментарий
- [ ] 6 sockets: 97-103; context 67; accessPolicy 50
- [ ] 7 проверки, PR

Сдвиг: код шагов 2-6 закоммичен; осталось: живой тест scripts/test-review-auth-live.ts (регистрация в manifest identity-owner.json и workflow), README (внешние запросы времени, FLUX_TRUST_PROXY/COOKIE_SECURE), PR.
База до: test-entity-id-migration-sqlite и test-project-delete-sqlite падают на origin/main (ColumnNotFound) — не мои.
