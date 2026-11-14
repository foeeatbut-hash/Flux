# write-integrity-opid — ход (исполнитель C, пункт 0.6 этапа 0)

Задание: `docs/roadmap/offline-work.md`, «### 0. Целостность записи», п. 0.6 и «К6»;
решение — `.claude/progress/write-integrity.md` (п. 4, «Договор между исполнителями»).
Ветка пуша: `claude/confident-brown-fprv2v`; ревизия старта `4a76872a`. Порты: сервер 3103, Vite 5103.

## Шаги
- [x] 1. `server/opReceipt.ts`, подключение в `server.ts` (после проверки входа и лицензии), CORS-заголовки, `localSchema.ts`
- [x] 2. Клиент: `src/config/env.ts` ставит `X-Flux-Op-Id` (автоповтора в env.ts нет — не добавлялся)
- [x] 3. `scripts/test-op-receipt.ts`, мутации (6 из 6 падают)
- [ ] 4. tsc, run-checks до/после, документ (shell.md), удалить этот файл

## Проверки «до» (rev 4a76872a, run-checks feedback import schema architecture)
35 наборов, 15 провалов — все среды (нет chromium, нет FLUX_USER/FLUX_PASS, нет Maria-фикстуры,
не было клиентов prisma у test-equipment-source-import). tsc — код 0 (после правок).

## Решение по 5xx и обрыву
Расписка остаётся PENDING (исход неизвестен), повтор получает 409 OP_IN_FLIGHT; уборка через 7 суток.
