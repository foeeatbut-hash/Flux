# Панель «Черновики»

Задание: docs/roadmap/drafts-panel.md (шаги 1–6, «Готово, когда»). Ветка
drafts/panel (внешний исполнитель сделал шаги 1–2, fffc253 и 63ab68b; main
слит в d9b120f). Один draft PR в main, коммит на шаг. Не трогать
src/components/vdr/, DocflowScreen, src/components/docflow/, modules/,
src/components/modules/.

Проверки «до» (d9b120f, Vite 5521, chromium-1243): tsc 0, architecture PASS;
run-checks drafts desktop taskbar explorer windows-files glass — 32 набора,
6 провалов. Не наши (были и на main): desktop-creation-ui (ждёт заголовок
«Проводник»), office-explorer-live (нужны редакторы), remaining-files-explorer-api
(маркер стенда), windows-files-electron (Electron не запускается в контейнере).
Сломаны веткой: taskbar-ui (DraftsLayer падал без ipcRenderer.on и гасил стол),
windows-explorer-ui (проверял рамку по черновику на столе).

Vite в этой копии не следит за файлами (.claude/** в ignored) — после правок
перезапускать.

- [x] 1–2. Проверены и исправлены: содержимое папки-черновика в корзине
  всплывало в источнике (и в «Только черновики»); в обычном окне панель висела
  на 48 px выше панели задач; падение слоя без моста; стенд стола переведён на
  проверку «черновик не выводится» и рамку на столе без моста оболочки.
- [ ] 3. Полоса с поиском/типами/сортировкой/датами/колесом.
- [ ] 4. Компактный вид, список, фильтры, низ.
- [ ] 5. Действия/публикация/DnD/сведения/старые/настройки.
- [ ] 6. Меры/снимки/документация shell.md/draft PR. Удалить файл хода.

Находки для шага 5 (внешнего исполнителя): publishDraft/Tree только в
исходную папку, target+keepCopy требуют расширения операции. VDR.fileNodeId —
серверный файл, draftId подставлять нельзя. Native Office sessions
owner=webContents; «открыт» не равно «изменён».
