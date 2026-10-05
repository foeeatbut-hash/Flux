import React from 'react';
import { SettingRow, Switch } from '../ui';
import { useDisplayStore } from '../../store/displayStore';

export default function DisplaySettings() {
  const available = useDisplayStore(s => s.available);
  const workspace = useDisplayStore(s => s.workspace);
  const busy = useDisplayStore(s => s.busy);
  const error = useDisplayStore(s => s.error);
  const apply = useDisplayStore(s => s.setAllMonitors);
  if (!available) return null;
  return <div id="monitors" className="fx-set-group">
    <h3 className="fx-group-title">Мониторы</h3>
    <SettingRow title="Рабочий стол на всех мониторах"
      desc="Перетаскивайте окна Flux между экранами. Разворачивание занимает один монитор. При отключении экрана открытые окна возвращаются на доступный.">
      <Switch label="Рабочий стол на всех мониторах" checked={workspace.enabled}
        disabled={busy || (!workspace.enabled && workspace.displays.length < 2)} onChange={v => void apply(v)} />
    </SettingRow>
    <div className="text-xs text-slate-500 dark:text-slate-400 py-2">
      {workspace.displays.length} мониторов · {workspace.enabled ? 'Все мониторы' : 'Обычное окно'}
      {workspace.displays.map((d, index) => <div key={d.id} className="pt-1">
        {index + 1}. {d.label}{d.primary ? ' · основной' : ''} · {d.bounds.w} × {d.bounds.h} · масштаб {Math.round(d.scaleFactor * 100)}%
      </div>)}
    </div>
    {workspace.mixedScale && <p className="text-xs text-slate-500 dark:text-slate-400 pb-2">
      У экранов разный масштаб Windows. Общий рабочий стол использует один масштаб отрисовки; на дополнительном экране текст может быть менее чётким.
    </p>}
    {error && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400 pb-2">{error}</p>}
  </div>;
}
