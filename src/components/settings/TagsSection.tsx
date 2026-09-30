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

// ── Раздел «Теги»: подразделы «Схема» и «Дерево» ─────────────────────────────
export default function TagsSection({ addToast }: any) {
  const [canvasMode, setCanvasMode] = useState<'click' | 'drag'>('click');
  const [treeMode, setTreeMode] = useState<'click' | 'drag'>('click');

  useEffect(() => {
    fetch('/api/settings/registry_link_mode').then(r => r.json()).then(d => {
      if (d.global === 'drag' || d.global === 'click') setCanvasMode(d.global);
    }).catch(() => {});
    fetch('/api/settings/tree_link_mode').then(r => r.json()).then(d => {
      if (d.global === 'drag' || d.global === 'click') setTreeMode(d.global);
    }).catch(() => {});
  }, []);

  const save = async (key: 'registry_link_mode' | 'tree_link_mode', m: 'click' | 'drag') => {
    const set = key === 'registry_link_mode' ? setCanvasMode : setTreeMode;
    const was = key === 'registry_link_mode' ? canvasMode : treeMode;
    set(m);
    // Способ связей общий для всех, и меняет его администратор. Раньше ответ
    // сервера не читался, и отказ показывался как «сохранено»
    const res = await fetch(`/api/settings/${key}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: null, value: m }),
    }).catch(() => null);
    if (!res?.ok) {
      set(was);
      addToast?.(res?.status === 403 ? 'Способ связей для всех меняет администратор' : 'Не удалось сохранить способ связей', 'error');
      return;
    }
    try { window.dispatchEvent(new CustomEvent('flux:settings-changed', { detail: { key, value: m } })); } catch (_) {}
    addToast?.('Способ создания связей сохранён', 'success');
  };

  return (
    <SectionShell title="Теги" desc="Настройки раздела «Теги»: способ создания связей на холсте и в дереве.">
      <div className="space-y-5">
        <div className="fx-set-group">
          <div className="fx-group-title mb-1">Схема · подключение связей</div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">Как соединять теги на холсте.</p>
          <LinkModeChooser
            value={canvasMode}
            onChange={(m) => save('registry_link_mode', m)}
            clickDesc="Кнопка «связать» на карточке → клик по целевому тегу. Минимум точности, удобно мышью."
            dragDesc="Точки-порты по краям карточки: тянешь линию от одного тега к другому."
          />
        </div>

        <div className="fx-set-group">
          <div className="fx-group-title mb-1">Дерево · подключение связей</div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">Как соединять теги во вкладке «Дерево связей».</p>
          <LinkModeChooser
            value={treeMode}
            onChange={(m) => save('tree_link_mode', m)}
            clickDesc="Кнопка «связать» у строки → клик по строке-получателю. Она станет дочерней."
            dragDesc="Перетаскиваешь строку тега на другую — перетащенный становится дочерним."
          />
        </div>
      </div>
    </SectionShell>
  );
}
