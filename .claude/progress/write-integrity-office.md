# write-integrity-office — исполнитель A, пункт 0.2 (Office)

Задание: ключ [documentId, revision, status] в догоняющей миграции, номер ревизии внутри
транзакции, 409 с `code`, отчёт о повторах, наборы и мутации. Главный файл хода:
`.claude/progress/write-integrity.md` (договор между исполнителями).
Ветка пуша: `claude/confident-brown-fprv2v`. Старт: 4a76872a.

Проверки «до» (`run-checks.ts office schema`): 55 наборов, 20 провалов — все живые/UI/окружение
(test-schema-databases и *-live, *-ui без сервера и браузера); список в /tmp/write-integrity-office/before-fail.txt.

## Шаги
- [x] 1. Догоняющая миграция ключа (server/officeRevisions.ts)
- [x] 2. Номер в транзакции, 409 + code (server/routes/officeRevisions.ts)
- [x] 3. Отчёт о повторах при старте (server.ts, одна строка)
- [x] 4. Набор scripts/test-office-revision-key.ts, запись в verification/manifests/files-office.json
- [ ] 4б. Мутации (убрать ключ; расчёт вне транзакции; P2002 не в 409) — временные правки, не коммитятся
- [ ] 5. tsc, run-checks office schema, страница office.md, удалить этот файл
