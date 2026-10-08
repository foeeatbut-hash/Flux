# e3-probe: вставка, экспорт и списки базы по настоящим сигнатурам

Задание (кратко): журнал p111723 (scratchpad/p111723): проект/листы/атрибуты работают; не работают вставка (все place.*),
экспорт листа (84 попытки), списки форматов/символов/классов/блоков, db.find; ложный успех "symbol.Load -> 0".
1) таблица "операция -> настоящий метод и сигнатура" по typelib (api-*.txt) + почему падало; 2) исправить пробу:
правильные вызовы первыми, успех Load/Place/Create только по ненулевому результату и новому id, убрать ложное "найдено",
экспорт по тому, что есть в описи, в export\; 3) самопроверка (фейк под новые сигнатуры), zip по тому же пути.
Коммиты без Co-Authored-By с моделью, только Claude-Session. Не пушить. Отчёт до 15 строк.
Ветка claude/custom-table-builder-design-38h1b8, старт f77c4e9. Самопроверка до: 102 пройдено, 0 провалов.

Факты из журнала: БД E3 - Access (ACE OLEDB) components.mdb/symbols.mdb (app.GetComponentDatabase/GetSymbolDatabase), в API
нет ни одного "списка компонентов/символов/классов/блоков" (Unknown name); Job.GetComponentIds даёт id (27), не имена;
Symbol.Load(name, version)/Place(shti,x,y,rot BSTR) возвращают 0 = неудача; Sheet.PlacePart(name,ver,x,y,rot) вернул 3 без эффекта;
Device.Create(name,assignment,location,comp,vers,after) - 6 аргументов (у пробы было 2-4); экспорт: Sheet.Export(format,version,file,flags),
Sheet.ExportImage(format,version,file,dpi,compression), Job.ExportPDF(file,shtids,options,password), у пробы были ExportDXF/ExportPNG (нет в API).

Шаги:
- [x] 1 Cand/Invoke-Attempt: успех по ненулевому id (-Pos), ложное "найдено" убрать
- [x] 2 вставка: правильные сигнатуры (LoadPart/PlacePart, Device.Create 6 арг., Symbol.Load/Place, ImportDrawing), эффект по новым id
- [x] 3 экспорт: Sheet.Export/ExportImage, Job.ExportPDF
- [x] 4 база через OLEDB (только чтение): таблицы, имена, поиск решения; id компонентов проекта -> имена
- [ ] 5 фейк и самопроверка, README, zip, git rm файла хода
- [ ] 6 (дополнение владельца, отдельный коммит) режим «только разместить»: вопрос имени компонента перед Y (кириллица в Read-Host при PS 5.1:
      InputEncoding UTF8 + лог кодов символов), параметр -PlaceOnly "<имя>", размещение на АКТИВНОМ листе (Job.GetActiveSheetId) правильными
      вызовами, без удаления/атрибутов/сохранения/временного листа, один Y, итог (id, имя, лист, координаты, вызов; Ctrl+Z/Delete), выход.
      README раздел; самопроверка на фейке: кириллица, активный лист, в журнале вызовов только Place-вызовы (+чтение).
