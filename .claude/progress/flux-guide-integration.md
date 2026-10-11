# Flux Guide, мессенджер и дополнение Flux Office

Ветка: codex/flux-guide-integration. База: 6d360b4b, совпадает с origin/main после fetch.

- [x] Аудит эталона Guide и Office v10, selective patch без qa/seed/debug
- [x] Удаление runtime Flux Play, сохранение общих прав и shell проверок
- [x] Guide + контекстные демонстрации + постоянная история, диапазоны и подтверждение смены проекта
- [x] Новый мессенджер и безопасные F ответы
- [ ] Только дополнение Flux Office (обычный Office не менять)
- [ ] Интеграция, tests, visual, сборка, PR

Baseline: исходный tsc на отдельной копии HEAD проходит; первоначальный запуск зависимостей требовал network permission и npm cache /tmp.

Текущая проверка: tsc, архитектура, 8 проверочных контрактов проходят. Guide UI включает настоящие DOCX/XLSX выгрузки, 300 строк с прокруткой/Escape и смену проекта в истории (confirm/cancel). Реальный ChatManagement: 16 браузерных проверок проходят. Изолированный live сервер Guide, Office addon API и Office file/CAS/ACL проходят. Office addon panel fixture проходит; тёмные заголовки исправлены, снимки с загруженными строками/схемой просмотрены. Основной остаток: native Word/Excel batch apply + row metadata save/reopen + actual editor regression, сборка и CI текущей ревизии.
