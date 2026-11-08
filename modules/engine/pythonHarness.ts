/**
 * Python-часть общей среды: загрузка подпрограмм в отдельные пространства
 * имён и вызов `compute(input)` с JSON на входе и выходе.
 *
 * Что здесь защищает, а что нет. Настоящая граница безопасности — песочница
 * (Worker в iframe с непрозрачным источником: нет сети, cookie, IPC Flux) и
 * проверка кода владельцем перед выпуском. Всё ниже — защита от ошибок и
 * случайных зависимостей, а не от злого кода: Python в одном интерпретаторе
 * нельзя полностью изолировать от Python.
 *
 * - у каждой подпрограммы свой словарь имён и свой `__builtins__`: переменные
 *   одной не видны другой, `open`, `input`, `exit` убраны; словарь создаётся заново
 *   на каждый расчёт, поэтому результат не зависит от прошлых вызовов;
 * - `import` пускает только список модулей без часов, сети, процессов и файлов
 *   (`time`, `datetime`, `os`, `sys`, `socket`, `subprocess`, `js`, `pyodide`…
 *   недоступны): расчёт не может зависеть от времени запуска;
 * - `random` перед каждым вызовом получает зерно из входа (по умолчанию 0):
 *   «случайность» повторяется, а настоящей случайности нет.
 */
export const PYTHON_ALLOWED_MODULES = [
  'math', 'cmath', 'json', 're', 'statistics', 'decimal', 'fractions', 'itertools', 'functools', 'collections',
  'operator', 'string', 'textwrap', 'dataclasses', 'typing', 'enum', 'random', 'bisect', 'heapq', 'array',
  'numbers', 'copy', 'abc', 'contextlib',
] as const;

export const PYTHON_HARNESS = String.raw`
import builtins as _b
import json as _json
import random as _random

_ALLOWED = frozenset(${JSON.stringify(PYTHON_ALLOWED_MODULES)})
_BLOCKED_BUILTINS = frozenset(('open', 'input', 'breakpoint', 'help', 'exit', 'quit', 'copyright', 'credits', 'license', 'memoryview'))
_real_import = _b.__import__

def _flux_import(name, globals=None, locals=None, fromlist=(), level=0):
    if level or name.split('.')[0] not in _ALLOWED:
        raise ImportError('Модуль «%s» недоступен во Flux: у подпрограммы нет часов, сети, процессов и файлов' % name)
    return _real_import(name, globals, locals, fromlist, level)

def _safe_builtins():
    table = {k: getattr(_b, k) for k in dir(_b) if k not in _BLOCKED_BUILTINS}
    table['__import__'] = _flux_import
    return table

_modules = {}

def _fresh(key):
    # Каждый расчёт получает чистое пространство имён: результат не зависит от прошлых вызовов,
    # как и у WebAssembly (там каждый расчёт — новый экземпляр)
    ns = {'__name__': 'flux_module', '__builtins__': _safe_builtins()}
    exec(_modules[key], ns)
    return ns

def flux_load(key, source):
    _modules[key] = compile(source, '<' + key + '>', 'exec')
    if not callable(_fresh(key).get('compute')):
        del _modules[key]
        raise TypeError('В logic/main.py нет функции compute(input)')

def flux_drop(key):
    _modules.pop(key, None)

def flux_call(key, text, seed):
    _random.seed(seed)
    out = _fresh(key)['compute'](_json.loads(text))
    try:
        return _json.dumps(out, allow_nan=False, separators=(',', ':'), ensure_ascii=False)
    except ValueError:
        raise ValueError('FLUX_NUMBER')
`;
