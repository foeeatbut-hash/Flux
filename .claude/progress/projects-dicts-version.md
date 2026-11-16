# Строка 3: сверка в проектах и справочниках, «компания», право на закупки

Ветка `claude/youthful-ride-rwzb0t`, PR в `main`. Образцы — теги
(`server/routes/tags.ts`, `src/components/registry/{tagWrite,tagRefusal,changeRules}`,
`scripts/test-tag-version-{routes,client,ui}.ts`), договор — `shell.md`,
«Версия записи и сверка» и «Отказ записи…».

## Решение (до кода)

### Маршруты
| Маршрут | Что делаем |
|---|---|
| PUT /api/projects/:id | `guardedWrite`, `expectedVersion` в теле; 409 VERSION_CONFLICT с `current`; нет записи — 404 RECORD_GONE |
| DELETE /api/projects/:id | `guardedDelete` + `openCheck`, `?expectedVersion=`; каскад `deleteProjectData` — в той же транзакции (`before`), время транзакции 120 с сохранить; служебный проект — 400 как раньше; повтор по уже удалённому — как у тега |
| POST /api/projects | создание, сверять нечего |
| POST …/dictionaries | создание, сверять нечего |
| POST …/dictionaries/:id/items | справочника нет — 404 RECORD_GONE (`createInsideGoneText('dictionary')`), а не 500 |
| PUT /api/dictionaries/items/:itemId | `guardedWrite` вместо снимка своим чтением; перенос значений тегов при переименовании категории — в `after` той же транзакции; повторы при P2034 оставить |
| DELETE /api/dictionaries/items/:itemId | `guardedDelete` + `openCheck`; потомки удаляются в `before`; `?expectedVersion=` |
| PUT …/tag-template | запись под версией: есть шаблон — сверка `expectedVersion`, нет — создание; клиент `saveTagTemplate` — PUT и `expectedVersion` (сейчас шлёт POST, которого нет; вызовов с экрана нет) |

Маршрута удаления и правки самого справочника (Dictionary) нет — и не заводим.
Запрос без версии принимается и сверяется с чтением сервера (общий договор).

### Что считается открытой записью
- **Проект** — открыта форма правки проекта в «Проектах» (`{ model: 'Project', id }`).
  Просто выбранный в переключателе проект открытой записью не считается.
- **Пункт справочника** — пункт (категория, вариант, значение, набор), который
  сейчас правят в строке или окне (`{ model: 'DictionaryItem', id }`).
- Справочник и шаблон тегов открытыми не бывают (карточки у них нет).

### Каскад
- **Удаление проекта** уносит всё по `server/projectDelete.ts`. Защита: в
  `cascade` — записи проекта, открытые у других: берём свежие отметки
  чужих окон (их мало) и оставляем те, что принадлежат проекту — Tag,
  EquipmentSystem, Monoblock, ComponentElement, DocRegister, DocRegisterItem,
  DictionaryItem. Обратный обход (от отметок к проекту), а не список всех
  записей проекта: в проекте могут быть десятки тысяч тегов.
- **Удаление пункта справочника** уносит всех потомков (`parentId`) —
  они же в `cascade`. Значения в тегах, записанные по id пункта, остаются
  как есть (как и раньше).

### Словарь (сделано руководителем)
`project` (проект), `dictionary` (справочник), `dictionaryItem` (пункт
справочника), `tagTemplate` (шаблон тегов) — `NOUNS` и `NOUN_OF_MODEL`.

### Клиент
- «Проекты» (`src/screens/ProjectsManagement.tsx`): версия из показанной
  записи; отказ — `ConflictNotice` на месте ошибки формы, набранное остаётся;
  удаление — отказ окном; правила полей `src/components/projects/changeRules.ts`
  (название, код, заказчик, подрядчик, описание, сведения, состояние).
- Справочники (`DictionaryEditor.tsx`, `useTagDict`, `useMarkingDict`,
  `usePresets`): общий модуль `src/components/dictionary/dictWrite.ts`
  (версия, запрос, разбор отказа) и `changeRules.ts` (код, название,
  родитель); все PUT/DELETE пунктов идут через него.
- Перестановка двух категорий — два запроса; отказ любого — показать и
  перечитать (не «всё или ничего», как и было).

### Право на закупки
`PATCH /api/tags/:id/procurement` и `PUT /api/tags/bulk-metadata` с
`source: 'Закупки'` требуют `procurement.manage` вместо `tags.manage`
(`server/permRoutes.ts`, проверка `test-review-auth`).

### «Компания»
Замены по `docs/plan.md` («Ждут ответа владельца»); поле «Компания» в
настройках проекта и чужие организации не трогаем; набор слов интерфейса
получает запрет с этим исключением.

### Чем доказывается
| Часть | Набор | Мутации |
|---|---|---|
| Сервер: проекты, пункты, шаблон | `scripts/test-project-dict-version-routes.ts` (настоящая служба на SQLite) | убрать сверку версии; убрать openCheck; убрать каскад из openCheck; вынести каскад из транзакции |
| Клиент | `scripts/test-project-dict-version-client.ts` | не слать версию; сбросить набранное при отказе |
| Интерфейс | `scripts/test-project-version-ui.ts`, `scripts/test-dict-version-ui.ts` (настоящая служба, обе темы) | не показывать перечень изменений |
| Право | `scripts/test-review-auth.ts` | убрать правило |
| «Компания» | набор слов интерфейса | вернуть слово |

## Ход
- [x] Решение, слова словаря, правка `test-version-guard` (модель без слова — `constructorDoc`)
- [x] A: сервер (проекты, справочники, шаблон, право на закупки) + набор маршрутов `test-project-dict-version-routes` (147 проверок); осталось — мутации
- [ ] C: «компания» + набор слов
- [ ] B1: клиент «Проекты» + набор интерфейса
- [ ] B2: клиент справочников + набор интерфейса
- [ ] Руководитель: CI, test-architecture, документы, plan.md
