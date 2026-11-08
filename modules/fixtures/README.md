# Примеры логики модулей Flux

`equipment-inspector` — встроенный пример (TypeScript, обработчики `setup`).
Остальное — **один и тот же расчёт «статистика числовых параметров» на каждом
языке**, который Flux умеет исполнять (решение владельца 7 ноября 2026: только
эти языки). Они проверяют, что результат одинаков до последнего разряда.

| Папка | Язык | Как исполняется | Файл логики |
|---|---|---|---|
| `typescript/` | TypeScript | Worker в окне модуля | `logic/main.ts` (экспорт `compute`) |
| `python/` | Python | Pyodide, общая среда Flux | `logic/main.py` (функция `compute(input)`) |
| `c/` | C | WebAssembly, wasi-libc, реактор | `logic/main.wasm` |
| `cpp/` | C++ | WebAssembly, libc++, реактор | `logic/main.wasm` |
| `rust/` | Rust | WebAssembly, `wasm32-unknown-unknown`, без импортов | `logic/main.wasm` |
| `go/` | Go (TinyGo) | WebAssembly, `wasm-unknown`, без импортов | `logic/main.wasm` |
| `csharp/` | C# (.NET 8) | WebAssembly, WASI-команда (stdin → stdout) | `logic/main.wasm` |

Общее для всех — `stats/form.json` (форма) и `stats/controls.json` (контрольные
примеры: «вход → ожидаемый выход с допуском»). Контрольные примеры и форму
собирает в пакет `scripts/fixtures/moduleLanguages.ts`; `scripts/test-modules-wasm.ts`
и `scripts/test-modules-parity.ts` прогоняют их на каждом языке.

## Договор .wasm (кратко)

Вход — JSON `{v, context, flux, state, seed?}`, выход — JSON `{state, calc:{out}}`.

* **Реактор** (C, C++, Rust, Go): экспорты `memory`, `flux_alloc(n) -> ptr`,
  `flux_run(ptr, len) -> outLen` (отрицательное — ошибка), `flux_output() -> ptr`;
  необязательный `_initialize` (WASI-реактор) или `flux_init`.
* **WASI-команда** (C#): `_start`, вход читается со stdin, выход пишется в stdout.
* Память: максимум записан в самом файле (реактор — до 1024 страниц = 64 МиБ,
  команда — до 2048 = 128 МиБ); без максимума выпуск не принимается.
* Импорты — только `flux.log`/`flux.abort` и урезанный WASI. Сеть, файлы, часы
  и JS-обёртки (`env.*`, `go.*`, `js.*`) отклоняются при проверке выпуска.
* Числа — float64; значения от 2^53 пишите с порядком (`1e150`, а не цифрами),
  целые больше 2^53 передавайте строкой; NaN и бесконечность — ошибка расчёта.

## Сборка

В репозитории лежат готовые `logic/main.wasm`, CI их не пересобирает: сборка
зависит от версий компиляторов. Инструкция и флаги — в `build.sh` каждой папки.
Проверено в контейнере разработки (Ubuntu 24.04):

| Язык | Тулчейн | Размер .wasm |
|---|---|---|
| C | clang 18 + wasi-libc (`apt install clang lld wasi-libc libclang-rt-dev-wasm32`) | 35 907 Б |
| C++ | clang++ 18 + libc++ для wasm32 (`apt install libc++-18-dev-wasm32 libc++abi-18-dev-wasm32`) | 48 957 Б |
| Rust | rustc 1.97, `rustup target add wasm32-unknown-unknown` | 67 544 Б |
| Go | TinyGo 0.39.0 (обычный Go выдаёт `GOOS=js`-модуль с JS-обёрткой, Flux её не даёт) | 50 592 Б |
| C# | .NET SDK 8 + рабочая нагрузка `wasi-experimental` + wasi-sdk 24, усечение (trimming) | 3 293 629 Б |

Python и TypeScript не собираются: Flux исполняет исходный текст.
