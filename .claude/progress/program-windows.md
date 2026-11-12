# Окна программ (страница программы, договор v2/v3)

Задание: пункт «Окна программ» очереди `docs/roadmap/studio-next.md`. Диалоги через Flux
(`flux.dialogs.confirm/alert/prompt`), заголовок и размер в `flux.windows.open(page, params, {title,width,height})`,
`flux.window.setTitle`, `flux.window.setUnsaved` (вопрос при закрытии). Всё добавлением к договору, клиент остаётся flux.v1.js.
Ветка: `claude/admiring-fermat-tad55v` (черновой PR #165). Старт: cc397d11.

## Шаги
- [x] 1. Договор и мост: новые op, схема, клиент, типы + проверки.
- [ ] 2. Flux: диалоги, заголовок/размер, вопрос о несохранённом + проверки в Chromium.
- [ ] 3. Studio и документы.

## Где остановился
Шаг 1 готов: op dialog-confirm/alert/prompt, window-title, window-unsaved, options в window-open; клиент, типы, мост, scripts/test-modules-windows.ts (71 проверка, живая часть в Chromium). tsc 0. Дальше шаг 2: ModuleFrame/ModuleHost (диалог WindowDialog, titles, размер окна в windowStore.openAnother, guardClose для setUnsaved).
Chromium: FLUX_CHROME=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome
