// Авто-обучение словаря распознавания. Работает молча: словарь синонимов
// пополняется как побочный эффект обычного импорта (Excel/Word — надёжные
// «учителя») и подтверждений. Хранится на сервере (AppSetting, общий для команды),
// поэтому знания накапливаются у всех и переживают переустановку.

import type { LearnObservation } from './types';
import type { LearnedEntry } from './dictionary';
import { setSymbolRules, type SymbolRule } from './symbols';

export type LearnedDict = Record<string, LearnedEntry>;

let dict: LearnedDict = {};
let buffer: LearnObservation[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Текущий словарь (передаётся в recognizeAsync) */
export function getLearnedDict(): LearnedDict {
  return dict;
}

/** Загрузка общего словаря с сервера (вызывать при открытии мастера импорта) */
export async function loadLearnedDict(): Promise<LearnedDict> {
  try {
    const r = await fetch('/api/import/dictionary');
    if (r.ok) {
      const d = await r.json();
      if (d && d.dict && typeof d.dict === 'object') dict = d.dict;
    }
  } catch {
    /* офлайн/недоступно — работаем с тем, что есть */
  }
  return dict;
}

/** Зарегистрировать наблюдения (из распознавания/подтверждения). Отправка отложенная. */
export function observe(observations: LearnObservation[] | undefined): void {
  if (!observations || !observations.length) return;
  // Оптимистично применяем локально, чтобы следующий файл в этой же сессии уже знал
  for (const o of observations) {
    if (!o.label || !o.field) continue;
    const prev = dict[o.label];
    if (!prev) dict[o.label] = { field: o.field, unit: o.unit, n: 1 };
    else if (prev.field === o.field) { prev.n = (prev.n || 1) + 1; if (o.unit && !prev.unit) prev.unit = o.unit; }
  }
  buffer.push(...observations);
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 1500);
}

async function flush(): Promise<void> {
  flushTimer = null;
  const obs = buffer;
  buffer = [];
  if (!obs.length) return;
  try {
    const r = await fetch('/api/import/learn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ observations: obs }),
    });
    if (r.ok) {
      const d = await r.json();
      if (d && d.dict && typeof d.dict === 'object') dict = d.dict;
    }
  } catch {
    /* не удалось — наблюдения не критичны, попадут при следующем импорте */
  }
}


// ── Справочник условных обозначений ──────────────────────────────────────────
// Правки отдела поверх стартового набора (src/import/symbols.ts): «L, м³/ч» —
// расход, «L, мм» — длина, «N» — мощность, «n» — обороты. Общий на команду,
// правится в Справочнике, применяется при каждом разборе бланка.
let symbols: SymbolRule[] = [];

export function getSymbolRules(): SymbolRule[] {
  return symbols;
}

export async function loadSymbolRules(): Promise<SymbolRule[]> {
  try {
    const r = await fetch('/api/import/symbols');
    if (r.ok) {
      const d = await r.json();
      if (d && Array.isArray(d.symbols)) symbols = d.symbols;
    }
  } catch {
    /* офлайн/недоступно — работаем со стартовым набором */
  }
  setSymbolRules(symbols);
  return symbols;
}
