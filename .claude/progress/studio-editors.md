# studio-editors — этап 4б-2: редакторы подпрограммы

Задание: редакторы формы (визуальный + текстовый), кода (CodeMirror 6), методология внутри
(checkFormDesign), каталог studio/renderer/editors/**, стенд для Playwright. Общие правила:
scratchpad/s4/COMMON.md. Ветка studio/stage-4b-editors от origin/main 5f64e1fe.

Шаги:
- [x] 1. Модель: типы, разбор JSON со строками, схема, привязки, хранилище, операции, типы из договора,
      подсказки кода, checkFormDesign, выписка методологии, предпросмотр; scripts/test-studio-editor.ts (179 проверок)
- [ ] 2. Интерфейс: FormEditor (палитра, дерево, свойства, предпросмотр), текстовый и кодовый редакторы на CodeMirror, index.tsx
- [ ] 3. Стенд (harness) и UI-набор test-studio-editor-ui.ts со снимками обеих тем
- [ ] 4. Манифест verification, docs (studio.md, modules.md), размер бандла, PR

Проверки «до»: нетронутая ревизия — наборы области не затронуты (новые файлы).
node_modules в рабочей копии — каталог симлинков на основной + @codemirror/* скопированы (в package.json добавлены).
