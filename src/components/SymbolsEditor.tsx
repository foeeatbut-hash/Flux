import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, Save, Trash2, RotateCcw, Sigma, AlertTriangle } from 'lucide-react';
import { useToastStore } from '../store/toastStore';
import { BASE_SYMBOLS, resolveSymbol, setSymbolRules, type SymbolRule } from '../import/symbols';
import { FIELDS } from '../import/dictionary';

// ── Справочник условных обозначений ─────────────────────────────────────────
// В бланках величина подписана символом, а не словом: «L = 5000 м³/ч».
// Один и тот же символ значит разное — «L, мм» это длина, «N» мощность,
// «n» обороты, — поэтому величину задаёт тройка «символ + регистр + единица».
//
// Стартовый набор поставляется с программой и правится не здесь: здесь отдел
// добавляет СВОИ правила поверх него. Так у бланка своего поставщика можно
// объяснить программе его обозначения, не трогая общие.

const emptyRule = (): SymbolRule => ({ symbol: '', field: 'airflow', label: '', units: [], caseSensitive: false });

export default function SymbolsEditor() {
  const { addToast } = useToastStore();
  const [rules, setRules] = useState<SymbolRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [probe, setProbe] = useState({ symbol: 'N', unit: 'кВт' });

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/import/symbols');
        const d = await r.json();
        if (Array.isArray(d?.symbols)) setRules(d.symbols);
      } catch { /* офлайн — работаем со стартовым набором */ }
      finally { setLoading(false); }
    })();
  }, []);

  const save = async () => {
    const clean = rules
      .map(r => ({ ...r, symbol: r.symbol.trim(), label: r.label.trim(), units: (r.units || []).map(u => u.trim()).filter(Boolean) }))
      .filter(r => r.symbol && r.label);
    setSaving(true);
    try {
      const r = await fetch('/api/import/symbols', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols: clean }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || 'Сервер отклонил справочник');
      setRules(d.symbols || clean);
      // Применяем сразу: следующий разбор бланка в этой же сессии уже знает
      setSymbolRules(d.symbols || clean);
      addToast(`Справочник обозначений сохранён: своих правил ${(d.symbols || clean).length}`, 'success');
    } catch (e: any) {
      addToast(`Не удалось сохранить: ${e?.message || 'ошибка сети'}`, 'error');
    } finally { setSaving(false); }
  };

  const patch = (i: number, up: Partial<SymbolRule>) =>
    setRules(list => list.map((r, j) => (j === i ? { ...r, ...up } : r)));

  // Проверка на месте: инженер видит, что ответит программа, не загружая бланк
  const answer = useMemo(() => {
    setSymbolRules(rules);
    const m = resolveSymbol(probe.symbol, probe.unit);
    if (!m) return null;
    return m;
  }, [rules, probe]);

  const fieldName = (id: string) => FIELDS.find(f => f.id === id)?.label || id;

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-slate-400"><Loader2 className="w-6 h-6 animate-spin" /></div>;
  }

  return (
    <div className="flex-1 overflow-auto p-4 space-y-5">
      <div>
        <h2 className="font-bold text-slate-800 dark:text-white text-lg flex items-center gap-2">
          <Sigma className="w-5 h-5 text-emerald-600" /> Условные обозначения
        </h2>
        <p className="text-xs text-slate-500 mt-1 max-w-2xl">
          Величину в бланке задаёт тройка «символ + регистр + единица»: «L, м³/ч» — расход,
          «L, мм» — длина, «N» — мощность, «n» — обороты. Ниже — правила вашего отдела;
          они кладутся поверх набора, который поставляется с программой.
        </p>
      </div>

      {/* Проверка на месте */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
        <div className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">Проверить</div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <input
            value={probe.symbol}
            onChange={e => setProbe(p => ({ ...p, symbol: e.target.value }))}
            placeholder="символ"
            className="w-24 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-transparent font-mono"
          />
          <span className="text-slate-400">,</span>
          <input
            value={probe.unit}
            onChange={e => setProbe(p => ({ ...p, unit: e.target.value }))}
            placeholder="единица"
            className="w-28 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-transparent font-mono"
          />
          <span className="text-slate-400">→</span>
          {answer ? (
            <span className="font-bold text-emerald-700 dark:text-emerald-400">
              {answer.label}
              <span className="ml-2 text-xs font-normal text-slate-400">
                {answer.byUnit ? 'решила единица' : 'единица не помогла'}
              </span>
            </span>
          ) : (
            <span className="text-slate-400">обозначение не распознано</span>
          )}
        </div>
        {answer && (answer.rivals || []).length > 0 && (
          <div className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-600">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            У этого символа есть и другие значения ({(answer.rivals || []).map(r => r.label).join(', ')}) —
            в предпросмотре программа спросит, какое имелось в виду.
          </div>
        )}
      </div>

      {/* Правила отдела */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-bold text-slate-500 uppercase tracking-widest">Правила отдела</div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setRules(l => [...l, emptyRule()])}
              className="flex items-center gap-1 text-xs font-bold px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-800 cursor-pointer">
              <Plus className="w-3.5 h-3.5" /> Добавить
            </button>
            <button type="button" onClick={save} disabled={saving}
              className="flex items-center gap-1 text-xs font-bold px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white cursor-pointer">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Сохранить
            </button>
          </div>
        </div>

        {rules.length === 0 ? (
          <div className="text-xs text-slate-400 italic border border-dashed border-slate-200 dark:border-slate-800 rounded-lg p-6 text-center">
            Своих правил нет — работает набор, поставляемый с программой.
          </div>
        ) : (
          <div className="space-y-2">
            {rules.map((r, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-800 p-2">
                <input
                  value={r.symbol}
                  onChange={e => patch(i, { symbol: e.target.value })}
                  placeholder="L"
                  title="Символ так, как он написан в бланке"
                  className="w-20 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-transparent font-mono text-sm"
                />
                <select
                  value={r.field}
                  onChange={e => patch(i, { field: e.target.value })}
                  title="Какая это величина"
                  className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-transparent text-sm"
                >
                  {FIELDS.filter(f => f.target === 'spec').map(f => (
                    <option key={f.id} value={f.id}>{f.label}</option>
                  ))}
                </select>
                <input
                  value={r.label}
                  onChange={e => patch(i, { label: e.target.value })}
                  placeholder="Подпись в карточке"
                  title="Как параметр подписывается в карточке оборудования"
                  className="flex-1 min-w-[10rem] px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-transparent text-sm"
                />
                <input
                  value={(r.units || []).join(', ')}
                  onChange={e => patch(i, { units: e.target.value.split(',').map(u => u.trim()).filter(Boolean) })}
                  placeholder="м³/ч, л/с"
                  title="Единицы, при которых правило срабатывает"
                  className="w-40 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-transparent font-mono text-sm"
                />
                <label className="flex items-center gap-1 text-xs text-slate-500 cursor-pointer" title="«N» и «n» — разные величины">
                  <input type="checkbox" checked={!!r.caseSensitive}
                    onChange={e => patch(i, { caseSensitive: e.target.checked })}
                    className="w-3.5 h-3.5 accent-emerald-500 cursor-pointer" />
                  регистр важен
                </label>
                <button type="button" onClick={() => setRules(l => l.filter((_, j) => j !== i))}
                  title="Убрать правило" className="p-1 text-slate-400 hover:text-rose-600 cursor-pointer">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Что поставляется с программой */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-bold text-slate-500 uppercase tracking-widest">Поставляется с программой</div>
          <button type="button"
            onClick={() => setRules(l => [...l, { ...BASE_SYMBOLS[0], label: BASE_SYMBOLS[0].label }])}
            title="Скопировать первое правило как заготовку"
            className="flex items-center gap-1 text-xs text-slate-400 hover:text-emerald-600 cursor-pointer">
            <RotateCcw className="w-3.5 h-3.5" /> взять за образец
          </button>
        </div>
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden">
          <table className="w-full text-xs">
            <thead className="text-slate-400 text-left bg-slate-50 dark:bg-slate-850">
              <tr>
                <th className="py-1.5 px-2 font-semibold">Символ</th>
                <th className="py-1.5 px-2 font-semibold">Величина</th>
                <th className="py-1.5 px-2 font-semibold">Подпись</th>
                <th className="py-1.5 px-2 font-semibold">Единицы</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-850">
              {BASE_SYMBOLS.map((r, i) => (
                <tr key={i}>
                  <td className="py-1 px-2 font-mono font-bold text-slate-700 dark:text-slate-300">
                    {r.symbol}{r.caseSensitive && <span className="ml-1 text-2xs text-amber-600" title="регистр важен">Aa</span>}
                  </td>
                  <td className="py-1 px-2 text-slate-500">{fieldName(r.field)}</td>
                  <td className="py-1 px-2 text-slate-600 dark:text-slate-300">{r.label}</td>
                  <td className="py-1 px-2 font-mono text-slate-400">{(r.units || []).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
