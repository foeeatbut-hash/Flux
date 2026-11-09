# Библиотека Excel (SheetJS) для Flux

Версия 0.18.5 с npmjs.org больше не обновляется и содержит известные уязвимости; исправленные
выпуски SheetJS публикует только на своём сервере. Чтобы сборка (в том числе Windows-сборка в CI)
не зависела от `cdn.sheetjs.com`, архив лежит в репозитории, а `package.json` ссылается на него:
`"xlsx": "file:vendor/xlsx/xlsx-0.20.3.tgz"`. `npm ci` ставит пакет из этого файла, сеть не нужна.

| Файл | Версия | SHA-256 | Лицензия |
|---|---|---|---|
| `xlsx-0.20.3.tgz` (2 409 319 Б) | SheetJS CE 0.20.3, `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` | `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8` | Apache-2.0 |

Целостность стережёт `scripts/test-vendor-xlsx.ts`: SHA-256 файла совпадает с таблицей, SHA-512
в `package-lock.json` совпадает с файлом, `package.json` и lock ссылаются на этот файл.

## Как обновить
1. Скачать новый архив с https://cdn.sheetjs.com (версия в адресе), положить сюда, старый удалить.
2. Поправить путь в `package.json`, выполнить `npm install --package-lock-only` и обновить таблицу.
3. Прогнать наборы разбора Excel (`test-blank-parser`, `test-office-excel-roundtrip`,
   `test-e3-attributes`, `test-remaining-identity-import-ui` и др.) и `test-vendor-xlsx`.
