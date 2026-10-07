import React, { useState, useEffect } from 'react';
import SectionShell from './SectionShell';
import { Check, MousePointerClick, Link2 } from 'lucide-react';

// Переиспользуемый выбор способа связи «Кликом / Перетаскиванием»
function LinkModeChooser({ value, onChange, clickDesc, dragDesc }: {
  value: 'click' | 'drag'; onChange: (m: 'click' | 'drag') => void; clickDesc: string; dragDesc: string;
}) {
  const opt = (mode: 'click' | 'drag', icon: React.ReactNode, title: string, desc: string) => (
    <button type="button"
      onClick={() => onChange(mode)}
      aria-pressed={value === mode}
      className={`flex-1 p-3 rounded-lg border text-left cursor-pointer transition-colors ${
        value === mode
          ? 'border-emerald-500 dark:border-emerald-600'
          : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
      }`}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span aria-pressed={value === mode}>{icon}</span>
        <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{title}</span>
        {value === mode && <Check className="w-4 h-4 text-emerald-600 ml-auto" />}
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">{desc}</p>
    </button>
  );
  return (
    <div className="flex gap-3 max-w-xl flex-col @[640px]:flex-row">
      {opt('click', <MousePointerClick className="w-4 h-4" />, 'Кликом', clickDesc)}
      {opt('drag', <Link2 className="w-4 h-4" />, 'Перетаскиванием', dragDesc)}
    </div>
  );
}

// ── Раздел «Теги»: способ создания связей ────────────────────────────────────
// Выбор один на холст и на дерево: два одинаковых выбора рядом только
// путали — человек привык к одному способу и не хочет настраивать его дважды.
// Хранится в registry_link_mode; прежний tree_link_mode в базе остаётся, но
// больше не читается и не пишется.
export default function TagsSection({ addToast }: any) {
  const [mode, setMode] = useState<'click' | 'drag'>('click');

  useEffect(() => {
    fetch('/api/settings/registry_link_mode').then(r => r.json()).then(d => {
      if (d.global === 'drag' || d.global === 'click') setMode(d.global);
    }).catch(() => {});
  }, []);

  const save = async (m: 'click' | 'drag') => {
    const was = mode;
    setMode(m);
    // Способ связей общий для всех, и меняет его администратор. Раньше ответ
    // сервера не читался, и отказ показывался как «сохранено»
    const res = await fetch('/api/settings/registry_link_mode', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: null, value: m }),
    }).catch(() => null);
    if (!res?.ok) {
      setMode(was);
      addToast?.(res?.status === 403 ? 'Способ связей для всех меняет администратор' : 'Не удалось сохранить способ связей', 'error');
      return;
    }
    try { window.dispatchEvent(new CustomEvent('flux:settings-changed', { detail: { key: 'registry_link_mode', value: m } })); } catch (_) {}
    addToast?.('Способ создания связей сохранён', 'success');
  };

  return (
    <SectionShell title="Теги" desc="Настройки раздела «Теги»: как соединять теги на холсте и в дереве.">
      <div className="fx-set-group">
        <div className="fx-group-title mb-1">Как соединять теги</div>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">Один способ для схемы-холста и для дерева связей.</p>
        <LinkModeChooser
          value={mode}
          onChange={save}
          clickDesc="Кнопка «связать» у тега или строки, затем клик по второму тегу. Не нужна точность, удобно мышью."
          dragDesc="На холсте — тянуть линию от точки-порта одного тега к другому; в дереве — перетащить строку тега на другую."
        />
      </div>
    </SectionShell>
  );
}
