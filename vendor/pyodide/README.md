# Пакеты Pyodide для portable

Pyodide (ядро, стандартная библиотека) ставится пакетом npm `pyodide` (devDependency, точная
версия в package.json) и при сборке копируется в `dist/modules/_compute/pyodide`
(`modules/build.ts`). Здесь лежат только колёса, которых нет в пакете npm: они входят в полный
выпуск Pyodide той же версии. Во время работы Flux сеть не нужна.

| Файл | Версия | SHA-256 | Лицензия |
|---|---|---|---|
| `numpy-2.2.5-cp313-cp313-pyemscripten_2025_0_wasm32.whl` (2 823 762 Б) | numpy 2.2.5 для Pyodide 0.29.5 | `800c98edc0c864dfa49f07005680c699b4b42b84eae1f8cb19d35b3634e7f05c` | BSD-3-Clause |

Сборка сверяет SHA-256 колеса с `pyodide-lock.json` пакета npm и останавливается при
несовпадении. Сама Pyodide распространяется по лицензии MPL-2.0 (файлы не изменяются).

## Как обновить
1. Поднять версию `pyodide` в package.json и `npm install`.
2. Скачать архив `pyodide-<версия>.tar.bz2` с https://github.com/pyodide/pyodide/releases, взять из него
   `numpy-*.whl` с именем из `node_modules/pyodide/pyodide-lock.json` (`packages.numpy.file_name`).
3. Заменить файл, обновить таблицу выше; `npm run build` проверит хеш.
