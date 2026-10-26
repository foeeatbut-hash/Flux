# Дефекты цепочки обновлений (аудит D1–D10)

Ветка claude/upbeat-euler-tawcnv (общее дерево; WindowsLayer/windowStore/windows.ts/Taskbar.tsx не трогать). Ревизия старта d0644c9.
Проверки до: `tsx scripts/run-checks.ts update` — 8 из 10 зелёные; test-update-ui и test-update-campaign-ui падают без Vite/учётных данных (среда).

- [x] 1. D1 + D10: порядок по версии, semver-сравнение (src/lib/versionCompare.ts, server/updateOrder.ts)
- [x] 2. D6 + D7: /latest и /check по метаданным; цепочка команд от головы устройства
- [ ] 3. D2 + D3: отказ закрытия -> ready, повторное использование файла, уборка flux-update-*
- [ ] 4. Методология: users.md / settings.md «Логика»
- [ ] 5. Итоговые проверки, финальный коммит без файла хода
