# Проба оборудования

Самостоятельная проба без базы данных. Она показывает настоящие экраны
«Оборудование» на синтетическом проекте.

Запустить из корня репозитория:

```sh
npx vite --config scripts/fixtures/equipment-ui/vite.config.ts --host 127.0.0.1 --port 4191
node scripts/fixtures/equipment-ui/check.mjs
```

Снимки сохраняются в `/tmp/flux-equipment-ui-<ширина>-<тема>.png`.
