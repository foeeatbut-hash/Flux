# docflow-management
Задание: перенос листа «Документооборот» из Настроек в Менеджмент (вкладка ?tab=docflow) + проект docs/docflow-integration.md + строка в docs/plan.md.
Старт: 40289d1. Порты 3312/5312.
- [x] Шаг 1: перенос (DocflowSettings в components/management, вкладка, management.md). Проверки: tsc 0; run-checks vdr/management/docflow/architecture — 0 провалов до и после; снимки обе темы /tmp/flux-design.
- [ ] Шаг 2: разведка для документа
- [ ] Шаг 3: docs/docflow-integration.md + plan.md
Заглушка src/components/settings/DocflowSection.tsx (re-export) — убрать вместе с записью docflow в SettingsScreen.
