# Контрольный расчёт «статистика числовых параметров» на Python для Flux.
# Тот же расчёт, что в C, C++, Rust, Go, C#, TypeScript (см. modules/fixtures/c/src/main.c):
# сложение по порядку, один корень, число читает float() после проверки записи.
import math
import re

# [+-]?(цифры[.цифры*]|.цифры)([eE][+-]?цифры)? — ровно то, что принимают все языки примера.
# [0-9], а не \d: \d в Python принимает и цифры других письменностей.
_NUMBER = re.compile(r"[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?")


def compute(input):
    equipment = (input.get("flux") or {}).get("equipment") or {}
    count, total, sumsq, low, high = 0, 0.0, 0.0, 0.0, 0.0
    for p in equipment.get("params") or []:
        text = p.get("value") if isinstance(p, dict) else None
        if not isinstance(text, str) or not text or len(text) >= 64 or not _NUMBER.fullmatch(text):
            continue
        v = float(text)
        if not math.isfinite(v):
            continue
        if count == 0:
            low = high = v
        if v < low:
            low = v
        if v > high:
            high = v
        total += v
        sumsq += v * v
        count += 1
    mean = total / count if count else 0.0
    rms = math.sqrt(sumsq / count) if count else 0.0
    if not (math.isfinite(total) and math.isfinite(mean) and math.isfinite(rms)):
        raise ValueError("NUMBER")
    return {"state": {}, "calc": {"out": {"count": count, "sum": total, "mean": mean, "rms": rms, "min": low, "max": high}}}
