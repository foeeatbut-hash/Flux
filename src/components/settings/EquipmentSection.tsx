import { useState, useEffect } from 'react';
import SectionShell from './SectionShell';
import { Trash2 } from 'lucide-react';

// ── Оборудование ───────────────────────────────────────────────────────────────
export default function EquipmentSection({ isAdmin, addToast }: any) {
  const [conflictMode, setConflictMode] = useState<'immediate' | 'wait'>('wait');
  const [categories, setCategories] = useState<Array<{ id: string; label: string; composite?: boolean }>>([]);
  const [newCat, setNewCat] = useState('');

  useEffect(() => {
    fetch('/api/settings/equip_conflict_mode').then(r => r.json()).then(d => {
      if (d.global === 'immediate') setConflictMode('immediate');
    }).catch(() => {});
    fetch('/api/equipment/categories').then(r => r.json()).then(d => {
      if (Array.isArray(d.categories)) setCategories(d.categories);
    }).catch(() => {});
  }, []);

  const saveConflictMode = async (m: 'immediate' | 'wait') => {
    const was = conflictMode;
    setConflictMode(m);
    // Режим общий для отдела; отказ сервера не должен выглядеть как выбор
    const res = await fetch('/api/settings/equip_conflict_mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: null, value: m }) }).catch(() => null);
    if (!res?.ok) {
      setConflictMode(was);
      addToast?.(res?.status === 403 ? 'Режим для всех меняет администратор' : 'Не удалось сохранить режим', 'error');
    }
  };

  const saveCategories = async (next: any[]) => {
    setCategories(next);
    await fetch('/api/equipment/categories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ categories: next }) }).catch(() => {});
  };

  return (
    <SectionShell title="Оборудование" desc="Поведение при импорте новых ревизий и категории оборудования.">
      <div className="space-y-5">
        <div className="fx-set-group">
          <div className="fx-group-title mb-1">При новой ревизии</div>
          <div className="fx-segctl" role="group" aria-label="При новой ревизии">
            <button type="button" onClick={() => saveConflictMode('wait')} aria-pressed={conflictMode === 'wait'}>Ждать решения (✓/✎)</button>
            <button type="button" onClick={() => saveConflictMode('immediate')} aria-pressed={conflictMode === 'immediate'}>Изменять сразу</button>
          </div>
        </div>

        <div className="fx-set-group">
          <div className="fx-group-title mb-1">Категории оборудования</div>
          <div className="space-y-1 mb-2 max-h-52 overflow-y-auto max-w-md">
            {categories.map(c => (
              <div key={c.id} className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-white dark:bg-slate-950 border border-slate-150 dark:border-slate-850 text-xs">
                <span>{c.label}</span>
                {isAdmin && !['AHU', 'FAN', 'VALVE', 'CURTAIN'].includes(c.id) && (
                  <button type="button" onClick={() => saveCategories(categories.filter(x => x.id !== c.id))} className="text-slate-400 hover:text-rose-500 cursor-pointer"><Trash2 className="w-3.5 h-3.5" /></button>
                )}
              </div>
            ))}
          </div>
          {isAdmin && (
            <div className="flex gap-2 max-w-md">
              <input value={newCat} onChange={e => setNewCat(e.target.value)} placeholder="Новая категория…" className="fx-input flex-1" />
              <button type="button"
                onClick={() => {
                  const label = newCat.trim();
                  if (!label) return;
                  saveCategories([...categories, { id: 'C' + Date.now(), label, composite: false }]);
                  setNewCat('');
                  addToast('Категория добавлена', 'success');
                }}
                className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold cursor-pointer"
              >
                Добавить
              </button>
            </div>
          )}
        </div>
      </div>
    </SectionShell>
  );
}
