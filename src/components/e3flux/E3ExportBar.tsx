/**
 * Полоса над схемой: прерванная выгрузка («сделано 7 из 12») с выбором
 * «Продолжить» или «Убрать сделанное» (8.2) и, только в dev-режиме, переключатель
 * поведения подставного E3 — «занят» и «обрыв на шаге N», чтобы эти случаи можно
 * было увидеть.
 */
import React from 'react';
import type { FakeE3 } from '../../../e3/fakeBridge';
import type { E3ExportInfo } from '../../services/e3ExportService';
import { Btn, Select } from '../ui';

const MODES = [{ value: 'ok', label: 'E3 работает' }, { value: 'busy', label: 'E3 занят' }, { value: 'cut3', label: 'обрыв на шаге 3' }, { value: 'cut8', label: 'обрыв на шаге 8' }];

export default function E3ExportBar({ interrupted, fake, busy, onResume, onUndo }: { interrupted: E3ExportInfo | null; fake: FakeE3 | null; busy: boolean; onResume: () => void; onUndo: () => void }) {
  const [mode, setMode] = React.useState('ok');
  if (!interrupted && !fake) return null;
  const change = (v: string) => {
    setMode(v);
    if (!fake) return;
    fake.mode.busy = v === 'busy';
    fake.mode.failAtStep = v === 'cut3' ? 3 : v === 'cut8' ? 8 : null;
  };
  return (
    <div className={`flex min-h-10 items-center gap-3 border-b border-slate-200 px-4 py-1 text-sm dark:border-slate-800 ${interrupted ? 'bg-amber-50 dark:bg-amber-500/10' : ''}`} role="status">
      {interrupted ? <>
        <span className="min-w-0 flex-1 truncate">Выгрузка прервана: сделано {interrupted.done} из {interrupted.steps}. Повтор по ключам связи не создаёт дублей.</span>
        <Btn tone="ghost" disabled={busy} onClick={onUndo} title="Убрать из E3 только то, что поставила эта выгрузка и чего инженер не трогал">Убрать сделанное</Btn>
        <Btn tone="plain" disabled={busy} onClick={onResume}>Продолжить</Btn>
      </> : <span className="flex-1" />}
      {fake && <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">Подставной E3
        <Select value={mode} onChange={change} aria-label="Поведение подставного E3" className="w-auto" options={MODES} /></label>}
    </div>
  );
}
