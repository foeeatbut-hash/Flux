# eq-xml-orphan-plan — привязка XML при удалении установки и панель плана импорта

Ветка: claude/upbeat-euler-tawcnv (дерево общее с исполнителем обратной связи: src/components/feedback/*, server/feedback/* не трогать). Ревизия старта: 267a1a0. Не пушить.

Задание: удаление установки снимает привязку XML (в той же транзакции); осиротевшие привязки не дают 409 при проверке/повторном импорте; причина 4xx/5xx в диагностике и в UI; панель плана импорта — компактная таблица; проверки; equipment.md.

Шаги:
- [x] 1 Сервер: detachXmlSourcesInTransaction, удаление установки, orphan в apply/check/list, тест test-equipment-source-orphan.ts
- [x] 2 Диагностика: reason у http.end и fetch.headers, test-diagnostics-reason.ts
- [ ] 3 Окно обновлений: строка «Установка удалена» + «Убрать привязку»; чистка локальных ссылок при удалении установки
- [ ] 4 Панель плана импорта (таблица, групповые действия, сводка-фильтр, шапка/подвал), снимки до/после
- [ ] 5 Проверки (tsc, equipment xml source, фикстуры), equipment.md, финал

Проверки «до» (наборы equipment xml source): 27 наборов, провалены 2 до меня: test-equipment-dialogs-escape (окна раздела найдены — 1), test-equipment-tag-sync-live (нужны FLUX_USER/PASS).
