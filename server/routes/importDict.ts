import type { Express, Request, Response } from 'express';
import { getPrisma, upsertSetting } from '../context.js';

// ── Общие словари импорта бланков ────────────────────────────────────────────
// Два общих (на всю команду) справочника, живущих в AppSetting:
//  • выученные подписи — «Производительность» = то же, что «Расход воздуха».
//    Пополняется молча из разбора Excel/Word и подтверждённых импортов;
//  • условные обозначения — «L, м³/ч» = расход, «L, мм» = длина, «N» = мощность,
//    «n» = обороты. Стартовый набор лежит в src/import/symbols.ts, здесь —
//    только правки отдела, которые кладутся поверх.
// Значения полей (fieldId) проверяет клиент: правило на неизвестную величину
// просто не срабатывает, поэтому серверу достаточно проверить форму.

const IMPORT_DICT_KEY = 'import_dictionary';
const SYMBOLS_KEY = 'import_symbols';

async function readJson(key: string, fallback: any): Promise<any> {
  const row = await getPrisma().appSetting.findFirst({ where: { key, userId: null } });
  if (!row?.value) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

const str = (v: any, max: number) => String(v ?? '').trim().slice(0, max);

export function registerImportDictRoutes(app: Express): void {
  app.get('/api/import/dictionary', async (_req: Request, res: Response) => {
    try {
      res.json({ dict: await readJson(IMPORT_DICT_KEY, {}) });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/import/learn', async (req: Request, res: Response) => {
    try {
      const observations: any[] = Array.isArray(req.body?.observations) ? req.body.observations : [];
      let dict: Record<string, { field: string; unit?: string; n: number }> = await readJson(IMPORT_DICT_KEY, {});

      for (const o of observations) {
        const label = str(o?.label, 60);
        const field = str(o?.field, 40);
        if (!label || !field || label.length < 2) continue;
        const unit = o?.unit ? str(o.unit, 24) : undefined;
        const prev = dict[label];
        if (!prev) {
          dict[label] = { field, unit, n: 1 };
        } else if (prev.field === field) {
          prev.n = (prev.n || 1) + 1;
          if (unit && !prev.unit) prev.unit = unit;
        } else {
          // Конфликт: другое поле — голосование, сильнейшее написание побеждает
          prev.n = (prev.n || 1) - 1;
          if (prev.n <= 0) dict[label] = { field, unit, n: 1 };
        }
      }

      // Ограничение размера: держим до 4000 самых «уверенных» записей
      const MAX = 4000;
      const keys = Object.keys(dict);
      if (keys.length > MAX) {
        keys.sort((a, b) => (dict[b].n || 0) - (dict[a].n || 0));
        const kept: typeof dict = {};
        for (const k of keys.slice(0, MAX)) kept[k] = dict[k];
        dict = kept;
      }

      await upsertSetting(IMPORT_DICT_KEY, null, JSON.stringify(dict));
      res.json({ dict });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Правки справочника обозначений: список правил отдела поверх стартового
  app.get('/api/import/symbols', async (_req: Request, res: Response) => {
    try {
      const list = await readJson(SYMBOLS_KEY, []);
      res.json({ symbols: Array.isArray(list) ? list : [] });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/import/symbols', async (req: Request, res: Response) => {
    try {
      const input = Array.isArray(req.body?.symbols) ? req.body.symbols : [];
      const clean = input.slice(0, 500).map((r: any) => ({
        symbol: str(r?.symbol, 16),
        field: str(r?.field, 40),
        label: str(r?.label, 80),
        units: Array.isArray(r?.units) ? r.units.slice(0, 12).map((u: any) => str(u, 24)).filter(Boolean) : [],
        caseSensitive: !!r?.caseSensitive,
      })).filter((r: any) => r.symbol && r.field && r.label);
      await upsertSetting(SYMBOLS_KEY, null, JSON.stringify(clean));
      res.json({ symbols: clean });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
}
