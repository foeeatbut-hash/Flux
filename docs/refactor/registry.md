# Registry.tsx — карта и план выноса

Раздел «Теги» — один компонент `Registry()` на 4 560 строк (файл — 4 681):
80 `useState`, 21 `useEffect`, 19 `useCallback`/`useMemo`. Режется не по
живому, а по этой карте. Номера строк — на ревизии 8b5d341; перед шагом их
сверять `grep -n` по комментарию-метке, а не верить числам.

Уже вынесено раньше: `components/registry/*` (BoardLinks, CardActions,
DuplicatesPanel, ExchangeTab, SegmentColumn, TagComments, TagSearchPanel,
TagVdrDocs, tagMeta), `lib/tagLayout`, `lib/tagTree`, `lib/tagExchange`.

## Карта

### Логика (121–2596)

| Строки | Метка в коде | Что это | Куда |
|---|---|---|---|
| 121–148 | «Панель связей», «Board cards expanded» | мелкие флаги доски | остаются |
| 149–156, 401–443, 1568–1628 | «Infinite Canvas Navigation», «Размер видимой области», «Центрирует холст», «Вписывает группу» | масштаб, сдвиг, вписывание | `useBoardCamera` |
| 157–190, 1556–1567 | «Режим «связать»», «Перетаскивание строки дерева» | связывание кликом и перетаскиванием | `useLinking` |
| 191–331, 1145–1555 | «Dynamo Revit Connection Wires», «Performance-optimized Refs», «Node Drag Start», «Unified MouseMove/MouseUp» | перетаскивание карточек и проводов | **ядро — последним** |
| 332–364 | «Pre-calculate tag positions», «Входящие связи», «Дубликаты» | производные данные графа | `useBoardGraph` |
| 365–400, 528–550 | «Filter/Search», «Выделение», «Контекстное меню», «Мини-панель», «Закрытие меню» | выделение и меню | `useBoardSelection` |
| 551–583, 616–633, 2165–2258 | «Quick manually create tag», «Brand Creation», «Cyrillic layout warning», «Manual fast tag create» | строка быстрого создания | `useQuickCreate` |
| 584–615, 1940–2164 | «Форма карточки», «Form description mechanics», «Переименование кода тега» | карточка тега: поля и автосохранение | `useTagForm` |
| 634–643, 913–991 | «Text Extractor Tool», «Regex splitting», «Extract tags from raw documentation» | разбор текста в теги | `useTagExtractor` (чистое — в `lib/`) |
| 644–677, 2382–2483 | «Independent segment filters», «Extract all unique values», «multi-segment query» | сборщик по сегментам | `useSegmentCollector` |
| 678–912 | «Load all tags», «Подсветка после захвата» | загрузка и подсветка | `useRegistryTags` |
| 1669–1761 | «Найти дубли» | перелёт к дублю | `useDuplicateNav` |
| 1762–1939 | «Глубокие ссылки от ИИ», «Поделиться в чате», «Центрировать дерево» | переходы по ссылкам | `useRegistryLinks` |
| 2259–2381 | «Delete Node», «Re-assign parenting», «Build tree», «lineage chain» | операции над деревом | `useTagTreeOps` |
| 2484–2596 | «List Virtualization», «Марки», «Excel export» | спецификация и выгрузка | к `SpecTable` |

### Разметка (2597–4681)

| Строки | Метка | Компонент |
|---|---|---|
| 2599–2639 | «Шапка», «Что принёс последний захват» | `RegistryHeader` |
| 2640–2836 | «QUICK PANEL», «Универсальный поиск» | `QuickCreateBar` |
| 2912–3058 | «Overlaid Zoom and Canvas Controls» | `BoardControls` |
| 3102–3570 | «GRAPH CARDS CONTROLLERS» (одна карточка ≈ 470 строк) | `BoardCard` |
| 3571–3600, 3690–3710 | «Панель выделения» ×2 | `SelectionBar` |
| 3603–3689 | «Меню правой кнопки по пустому холсту» | `BoardContextMenu` |
| 3711–3759 | «TREE VIEW» | `TreeTab` |
| 3760–4076 | «TAB 4: ADVANCED SEGMENT COLLECTOR» | `SegmentCollectorTab` |
| 4077–4276 | «SPECIFICATION TABLE» | `SpecTable` |
| 4277–4681 | «Карточка тега» | `TagCardModal` |

## Порядок

Правило: сначала куски, которым хватает пропсов, потом хуки состояния, в
самом конце — ядро доски. Один шаг — один субагент, строго по очереди (все
шаги правят один файл).

1. `SpecTable` + выгрузка (4077–4276, 2484–2596) — пропсы: отфильтрованные
   теги, колонки, обработчики открытия карточки.
2. `SegmentCollectorTab` вместе с `useSegmentCollector` — сборщику не нужна
   доска, его состояние ни с кем не делится.
3. `TagCardModal` — сначала разметкой с пропсами; `useTagForm` — отдельным
   шагом 3б, если пропсов выйдет больше ~25.
4. `BoardCard` — самая большая часть разметки; пропсы — тег, флаги
   (раскрыт, выделен, режим связи), обработчики. Мемоизировать нельзя без
   замера: поведение перерисовки должно остаться прежним.
5. `QuickCreateBar` + `useQuickCreate`.
6. `RegistryHeader`, `BoardControls`, `BoardContextMenu`, `SelectionBar`,
   `TreeTab` — мелкие, можно одним шагом.
7. Хуки: `useRegistryTags`, `useDuplicateNav`, `useRegistryLinks`,
   `useTagTreeOps`, `useTagExtractor`.
8. `useBoardCamera`, `useBoardSelection`, `useLinking`, `useBoardGraph`.
9. Ядро перетаскивания — только если после шагов 1–8 файл ещё больше
   ~1 200 строк. Здесь refs и обработчики мыши переплетены, и цена ошибки —
   рывки доски, которые проверки ловят плохо.

Куда класть: компоненты — `src/components/registry/`, хуки —
`src/components/registry/useX.ts` (им нужен React, в `lib/` нельзя), чистые
функции — `src/lib/`.

## Проверки шага

- `npx tsc --noEmit`, `npm run check -- architecture`;
- с сервером: `npm run check -- layout flow tag-canvas tag-tree position-add`
  (живые наборы раздела берутся по словам явно);
- снимок «Тегов» (холст, дерево, спецификация, открытая карточка) в обеих
  темах — до и после, сравнить глазами;
- шаг, который меняет поведение (не проходит `flow` или снимок другой),
  откатывается, а не чинится на ходу: границу пересматривает руководитель.
