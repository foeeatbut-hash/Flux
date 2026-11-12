/**
 * Python-часть общей среды: загрузка программ в отдельные пространства
 * имён и вызов `compute(input)` с JSON на входе и выходе.
 *
 * Что здесь защищает, а что нет. Настоящая граница безопасности — песочница
 * (Worker в iframe с непрозрачным источником: нет сети, cookie, IPC Flux) и
 * проверка кода владельцем перед выпуском. Всё ниже — защита от ошибок и
 * случайных зависимостей, а не от злого кода: Python в одном интерпретаторе
 * нельзя полностью изолировать от Python.
 *
 * - у каждой программы свой словарь имён и свой `__builtins__`: переменные
 *   одной не видны другой, `open`, `input`, `exit` убраны; словарь создаётся заново
 *   на каждый расчёт, поэтому результат не зависит от прошлых вызовов;
 * - `import` пускает только список модулей без часов, сети, процессов и файлов
 *   (`time`, `datetime`, `os`, `sys`, `socket`, `subprocess`, `js`, `pyodide`…
 *   недоступны): расчёт не может зависеть от времени запуска;
 * - каждая программа получает СВОИ копии разрешённых модулей (только публичные имена,
 *   без вложенных модулей): подмена `math.sqrt` одной программой другой не видна, а
 *   `json.codecs.sys` или `statistics.sys` не существуют;
 * - `random` и `statistics` — собственные, на чистом Python и без `os`/`sys`: генератор
 *   получает зерно из входа (по умолчанию 0), «случайность» повторяется, настоящей нет;
 *   через стандартный `random._os` до `sys.modules['time']` добраться нельзя.
 *
 * numpy отдаётся настоящий (его подмодули — linalg, random — нужны), один на все программы:
 * глобальный `numpy.random` получает зерно перед каждым расчётом, а `default_rng()` без
 * зерна случаен — пишите `default_rng(seed)`.
 *
 * Чего это НЕ закрывает: функции стандартной библиотеки (`json.dumps`, `re.compile`…)
 * остаются общими, и через `func.__globals__` из них достижим настоящий `sys`. Закрыть
 * интроспекцию Python нельзя; граница безопасности — песочница, а расчёт без злого умысла
 * от времени и случайности не зависит.
 */
export const PYTHON_ALLOWED_MODULES = [
  'math', 'cmath', 'json', 're', 'statistics', 'decimal', 'fractions', 'itertools', 'functools', 'collections',
  'operator', 'string', 'textwrap', 'dataclasses', 'typing', 'enum', 'random', 'bisect', 'heapq', 'array',
  'numbers', 'copy', 'abc', 'contextlib', 'numpy',
] as const;

/** Собственные модули: исполняются в словаре, где из модулей есть только math */
const PYTHON_RANDOM = String.raw`
_M = 0xFFFFFFFFFFFFFFFF

class Random:
    def __init__(self, a=0):
        self.seed(a)

    def seed(self, a=0):
        self._s = ((int(a) & _M) ^ 0x9E3779B97F4A7C15) or 1

    def _next(self):
        x = self._s
        x ^= x >> 12
        x ^= (x << 25) & _M
        x ^= x >> 27
        self._s = x
        return (x * 0x2545F4914F6CDD1D) & _M

    def random(self):
        return (self._next() >> 11) / 9007199254740992.0

    def getrandbits(self, k):
        if k < 0:
            raise ValueError('number of bits must be non-negative')
        out, got = 0, 0
        while got < k:
            out = (out << 64) | self._next()
            got += 64
        return out >> (got - k) if k else 0

    def _below(self, n):
        if n <= 0:
            raise ValueError('empty range')
        bits = n.bit_length()
        r = self.getrandbits(bits)
        while r >= n:
            r = self.getrandbits(bits)
        return r

    def randrange(self, start, stop=None, step=1):
        if stop is None:
            start, stop = 0, start
        n = (stop - start + step - 1) // step if step > 0 else (start - stop - step - 1) // -step
        if n <= 0:
            raise ValueError('empty range for randrange()')
        return start + step * self._below(n)

    def randint(self, a, b):
        return self.randrange(a, b + 1)

    def uniform(self, a, b):
        return a + (b - a) * self.random()

    def choice(self, seq):
        if not len(seq):
            raise IndexError('Cannot choose from an empty sequence')
        return seq[self._below(len(seq))]

    def shuffle(self, x):
        for i in range(len(x) - 1, 0, -1):
            j = self._below(i + 1)
            x[i], x[j] = x[j], x[i]

    def sample(self, population, k):
        pool = list(population)
        if not 0 <= k <= len(pool):
            raise ValueError('Sample larger than population or is negative')
        for i in range(k):
            j = i + self._below(len(pool) - i)
            pool[i], pool[j] = pool[j], pool[i]
        return pool[:k]

    def choices(self, population, weights=None, k=1):
        if weights is None:
            return [self.choice(population) for _ in range(k)]
        total = _m.fsum(weights)
        out = []
        for _ in range(k):
            r = self.random() * total
            acc = 0.0
            for item, w in zip(population, weights):
                acc += w
                if r < acc:
                    break
            out.append(item)
        return out

    def gauss(self, mu=0.0, sigma=1.0):
        u1 = 1.0 - self.random()
        u2 = self.random()
        return mu + sigma * _m.sqrt(-2.0 * _m.log(u1)) * _m.cos(2.0 * _m.pi * u2)

_inst = Random(0)
seed = _inst.seed
random = _inst.random
getrandbits = _inst.getrandbits
randrange = _inst.randrange
randint = _inst.randint
uniform = _inst.uniform
choice = _inst.choice
shuffle = _inst.shuffle
sample = _inst.sample
choices = _inst.choices
gauss = _inst.gauss
`;

const PYTHON_STATISTICS = String.raw`
class StatisticsError(ValueError):
    pass

def _need(data, n=1):
    data = list(data)
    if len(data) < n:
        raise StatisticsError('недостаточно данных')
    return data

def fmean(data):
    data = _need(data)
    return _m.fsum(data) / len(data)

def mean(data):
    return fmean(data)

def median(data):
    data = sorted(_need(data))
    n = len(data)
    return data[n // 2] if n % 2 else (data[n // 2 - 1] + data[n // 2]) / 2

def median_low(data):
    data = sorted(_need(data))
    return data[(len(data) - 1) // 2]

def median_high(data):
    data = sorted(_need(data))
    return data[len(data) // 2]

def _ss(data, mu):
    return _m.fsum((x - mu) ** 2 for x in data)

def pvariance(data, mu=None):
    data = _need(data)
    return _ss(data, fmean(data) if mu is None else mu) / len(data)

def variance(data, xbar=None):
    data = _need(data, 2)
    return _ss(data, fmean(data) if xbar is None else xbar) / (len(data) - 1)

def pstdev(data, mu=None):
    return _m.sqrt(pvariance(data, mu))

def stdev(data, xbar=None):
    return _m.sqrt(variance(data, xbar))
`;

export const PYTHON_HARNESS = String.raw`
import builtins as _b
import json as _json
import math as _real_math
import types as _types
import sys as _sys

_ALLOWED = frozenset(${JSON.stringify(PYTHON_ALLOWED_MODULES)})
_BLOCKED_BUILTINS = frozenset(('open', 'input', 'breakpoint', 'help', 'exit', 'quit', 'copyright', 'credits', 'license', 'memoryview'))
_real_import = _b.__import__
_PURE = {'random': ${JSON.stringify(PYTHON_RANDOM)}, 'statistics': ${JSON.stringify(PYTHON_STATISTICS)}}

def _public(name, source):
    out = _types.ModuleType(name)
    for k, v in source.items():
        # Только публичные имена и не модули: так не остаётся пути вида json.codecs.sys или statistics.sys
        if k.startswith('_') or isinstance(v, _types.ModuleType):
            continue
        setattr(out, k, v)
    return out

def _pure(name, seed):
    ns = {'__name__': name, '_m': _real_math}
    exec(compile(_PURE[name], '<flux:' + name + '>', 'exec'), ns)
    if name == 'random':
        ns['_inst'].seed(seed)
    return _public(name, ns)

def _make_builtins(seed):
    table = {k: getattr(_b, k) for k in dir(_b) if k not in _BLOCKED_BUILTINS}
    facades = {}

    def _facade(name):
        if name not in facades:
            facades[name] = _pure(name, seed) if name in _PURE else _public(name, vars(_real_import(name)))
            if name == 'collections':
                facades[name].abc = _public('collections.abc', vars(_real_import('collections.abc')))
        return facades[name]

    def _flux_import(name, globals=None, locals=None, fromlist=(), level=0):
        root = name.split('.')[0]
        if root == 'numpy' and not level:
            return _real_import(name, globals, locals, fromlist, 0)
        if level or root not in _ALLOWED or ('.' in name and name != 'collections.abc'):
            raise ImportError('Модуль «%s» недоступен во Flux: у программы нет часов, сети, процессов и файлов' % name)
        facade = _facade(root)
        return facade.abc if name == 'collections.abc' and fromlist else facade

    table['__import__'] = _flux_import
    return table

_modules = {}

def _fresh(key, seed=0):
    # Каждый расчёт получает чистое пространство имён и свои копии модулей: результат не зависит
    # от прошлых вызовов и от того, что сделали с math или json другие программы
    ns = {'__name__': 'flux_module', '__builtins__': _make_builtins(seed)}
    exec(_modules[key], ns)
    return ns

def _seed_numpy(seed):
    np = _sys.modules.get('numpy')
    if np is not None:
        np.random.seed(int(seed) & 0xFFFFFFFF)

def flux_load(key, source):
    _modules[key] = compile(source, '<' + key + '>', 'exec')
    if not callable(_fresh(key).get('compute')):
        del _modules[key]
        raise TypeError('В logic/main.py нет функции compute(input)')

def flux_drop(key):
    _modules.pop(key, None)

def flux_call(key, text, seed):
    _seed_numpy(seed)
    out = _fresh(key, seed)['compute'](_json.loads(text))
    try:
        return _json.dumps(out, allow_nan=False, separators=(',', ':'), ensure_ascii=False)
    except ValueError:
        raise ValueError('FLUX_NUMBER')
`;
