# Explorer, DictionaryEditor, ChatManagement — карты и план выноса

Все три — один компонент на весь файл, как Registry. Правила и проверки шага —
те же, что в [registry.md](registry.md): сначала разметка на пропсах, потом
хуки, общее состояние остаётся в экране. Номера строк — на ревизии 8b5d341,
перед шагом сверять `grep -n` по метке.

## DictionaryEditor.tsx (2 208) — самый простой из трёх

Экран — три независимые панели «Справочника» с одинаковым устройством:
категории слева, значения справа, у каждой панели свои обработчики.

| Строки | Что | Куда |
|---|---|---|
| 54–63, 390–693, разметка 1159–1427 | создание тегов: категории и опции | `components/dictionary/TagDictPanel.tsx` + `useTagDict.ts` |
| 64–75, 694–890, разметка 1428–1686 | маркировка: категории и значения | `MarkingDictPanel.tsx` + `useMarkingDict.ts` |
| 76–90, 891–1087, разметка 1687–2208 | пресеты фильтров и подварианты | `PresetsPanel.tsx` + `usePresets.ts` |
| 91–142 | `getOrderNumber`, `getOrderedItems` | чистые — `src/lib/dictOrder.ts` |
| 143–335 | автозасев и загрузка словарей | остаются в экране (нужны всем трём) |

Порядок: сначала чистые функции, затем по панели на шаг — пресеты, маркировка,
теги. Проверки: `tsc`, `architecture`, `layout`, `flow`, снимок «Справочника»
на каждой из трёх панелей в обеих темах.

## Explorer.tsx (2 394)

Уже вынесено: `components/explorer/*` (ExplorerMenu, ExplorerTabs, FileItems,
FilePreview, FileProperties, FileVersionsDialog).

| Строки | Метка | Куда |
|---|---|---|
| 1381–1513 | «Explorer Top Bar», «Address Bar Row», «Фильтр по статусу» | `ExplorerToolbar.tsx` |
| 1514–1607 + `TreeFolder` (2321–2370) | «Tree Sidebar», «Подборки», «Корзина» | `ExplorerSidebar.tsx` |
| 1643–~1700 | «Корзина: отдельный вид» | `TrashView.tsx` |
| 1608–1925 (без корзины) | «Main Pane - Table View» | `FileTable.tsx` |
| 1926–2030 | «Preview Pane» | `PreviewPane.tsx` |
| 2236–2320 | выбор категории оборудования, «Прикрепить к строке ВДР» | `EquipmentImportDialog.tsx`, `VdrAttachDialog.tsx` |
| 291–438 | импорт файлов в «Оборудование» | `useEquipmentImport.ts` |
| 474–528 | разделы (диск, общий, личный) | `useExplorerSections.ts` |
| 180–243 | буфер обмена и горячие клавиши | `useExplorerClipboard.ts` |
| 789–1187 | «Actions»: удалить, переименовать, статус, перенос | последним: переплетено с выделением и вкладками |

Порядок: диалоги → панель просмотра → боковая панель → корзина → тулбар →
таблица → хуки. Проверки: + `explorer-tabs`, `drop-files`, `downloads`,
`disk-live`; снимок Проводника (таблица, корзина, открытый просмотр).

## ChatManagement.tsx (1 841)

Уже вынесено: `components/chat/*` (MessageBubble, useAssistantCall и др.).

| Строки | Метка | Куда |
|---|---|---|
| 817–919 | «LEFT PANEL: Users List & Automated Project Rooms» | `ChatSidebar.tsx` |
| 924–1037 | «Thread Header Info bar», поиск, меню диалога | `ThreadHeader.tsx` |
| 1135–1362 | поле ввода, подсказки, вложения, эмодзи | `Composer.tsx` |
| 1363–1540 | «RIGHT PANEL: Peer Profile / TAG Card» | `ChatInfoPanel.tsx` |
| 1541–1630 | «EQUIPMENT SELECTION … DIALOG» | `EquipmentPickDialog.tsx` |
| 257–265, 381–402, 682–813, 1631–1712 | снимок экрана и рисование пером | `ScreenshotAnnotator.tsx` + `useScreenshotDraw.ts` |
| 1713–1841 | модалки: создание группы, пересылка, настройки | `GroupDialogs.tsx` |
| 216–234, 278–305 | подсказки тегов при вводе | `useTagAutocomplete.ts` |

Порядок: модалки и снимок → правая панель → левая → шапка → поле ввода →
хуки. Лента сообщений (1049–1134) — последней: там прокрутка и подгрузка.
Проверки: + `chat-privacy`, `chat-grouping`, `assistant-chats`; снимок
Мессенджера (список, открытая переписка, панель справа).
