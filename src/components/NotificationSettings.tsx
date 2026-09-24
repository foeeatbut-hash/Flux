import React, { useState } from 'react';
import { Bell, Volume2, Play } from 'lucide-react';
import { getPrefs, savePrefs, NOTIF_CATEGORIES, NotifPrefs, playNotifSound } from '../lib/notifPrefs';

/**
 * Настройки уведомлений сотрудника: что показывать и что должно звучать.
 *
 * Категории здесь ровно те, что программа действительно присылает, и у
 * каждой написано, о чём она. Раньше список обещал «Оборудование» и
 * «Проекты», которые никогда не приходили, и молчал про документы ВДР,
 * которые приходили.
 *
 * У каждой категории свой тон сигнала, рядом кнопка «прослушать»: так можно
 * решить, на что отрываться от работы, не дожидаясь самого события.
 */
export default function NotificationSettings() {
  const [prefs, setPrefs] = useState<NotifPrefs>(() => getPrefs());

  const update = (next: NotifPrefs) => { setPrefs(next); savePrefs(next); };

  const Toggle = ({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) => (
    <button type="button" onClick={onClick} role="switch" aria-checked={on} aria-label={label}
      className={`relative w-9 h-5 rounded-full transition-colors shrink-0 cursor-pointer ${on ? 'bg-emerald-600' : 'bg-slate-300 dark:bg-slate-700'}`}>
      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-ui ${on ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  );

  return (
    <div className="space-y-3">
      {/* Общие переключатели */}
      <div className="space-y-2">
        <div className="flex items-center justify-between p-2.5 rounded-lg border border-slate-200 dark:border-dark-border bg-slate-50 dark:bg-dark-surface">
          <span className="flex items-center gap-2 text-xs font-semibold text-slate-800 dark:text-dark-text-main">
            <Bell className="w-4 h-4 text-amber-500" /> Всплывающие справа
          </span>
          <Toggle on={prefs.popups} label="Всплывающие уведомления"
            onClick={() => update({ ...prefs, popups: !prefs.popups })} />
        </div>
        <div className="flex items-center justify-between p-2.5 rounded-lg border border-slate-200 dark:border-dark-border bg-slate-50 dark:bg-dark-surface">
          <span className="flex items-center gap-2 text-xs font-semibold text-slate-800 dark:text-dark-text-main">
            <Volume2 className="w-4 h-4 text-emerald-500" /> Звук уведомлений
          </span>
          <Toggle on={prefs.sound} label="Звук уведомлений"
            onClick={() => update({ ...prefs, sound: !prefs.sound })} />
        </div>
      </div>

      {/* По категориям */}
      <div>
        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 px-1 mb-1 text-xs font-medium text-slate-400">
          <span>Категория</span><span>Показ</span><span>Звук</span><span className="w-5" />
        </div>
        <div className="space-y-1.5">
          {NOTIF_CATEGORIES.map(c => {
            const cur = prefs.categories[c.id] || { show: true, sound: true };
            return (
              <div key={c.id} className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 items-center p-2 rounded-lg border border-slate-200 dark:border-dark-border">
                <span className="min-w-0">
                  <span className="block text-xs font-semibold text-slate-700 dark:text-dark-text-main truncate">{c.label}</span>
                  <span className="block text-2xs text-slate-400 truncate">{c.desc}</span>
                </span>
                <Toggle on={cur.show} label={`Показывать: ${c.label}`}
                  onClick={() => update({ ...prefs, categories: { ...prefs.categories, [c.id]: { ...cur, show: !cur.show } } })} />
                <Toggle on={cur.sound} label={`Звук: ${c.label}`}
                  onClick={() => update({ ...prefs, categories: { ...prefs.categories, [c.id]: { ...cur, sound: !cur.sound } } })} />
                <button type="button" onClick={() => playNotifSound(c.id)}
                  title="Прослушать сигнал этой категории"
                  className="p-1 rounded-md text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 cursor-pointer">
                  <Play className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>
        <p className="text-2xs text-slate-400 mt-2">
          «Показ» — всплывашка справа. В колокольчике событие останется в любом случае, чтобы ничего не потерялось.
          Ошибки показываются всегда. Настройки хранятся в профиле и переезжают вместе с вами на другой компьютер.
        </p>
      </div>
    </div>
  );
}
