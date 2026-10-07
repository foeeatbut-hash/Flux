import React from 'react';
import { Seg } from '../ui';

// ── Спорные позиции в предпросмотре импорта ──────────────────────────────────
// Позиция расчёта находится в проекте не только по адресу: по тегу, по составу,
// по типоразмеру. Где программа не уверена — переехала ли позиция, переподобрана
// ли, стала ли другим изделием, — она не решает за инженера, а спрашивает.
// Умолчание уже выбрано по правилам (docs/e3-integration.md, 1.4), поэтому
// ничего не трогавший инженер получает разумный результат, а трогавший — свой.

export interface MatchRow {
  key: string;
  kind: 'moved' | 'address';
  closeness: 'near' | 'far' | 'other';
  title: string;
  at: string;
  was: { id: string; title: string; at: string; tags: string[]; label: string };
  now: { label: string };
  why: string;
  options: { value: string; label: string }[];
  default: string;
  choice: string;
}

export interface SystemRow {
  key: string;
  kind: 'rename' | 'pick';
  name: string;
  why: string;
  options: { value: string; label: string }[];
  default: string;
  choice: string;
}

/** Позиция проекта, которой нет в расчёте: по умолчанию будет снята (не удалена) */
export interface MissingRow {
  key: string; id: string; systemName: string; title: string; at: string; tags: string[]; remove: boolean;
}

interface Props {
  matches: MatchRow[];
  missing?: MissingRow[];
  systemRows: SystemRow[];
  /** Решения: ключ строки → вариант. Нет ключа — действует умолчание */
  choices: Record<string, string>;
  onChange: (key: string, value: string) => void;
}

const HINT: Record<string, string> = {
  same: 'Новые данные пишутся в прежнюю запись: ID, тег и связь с E3 сохраняются',
  reselect: 'Прежняя запись снимается, заводится новая, теги переходят на неё, между записями ставится связь «заменено на»',
  other: 'Прежняя запись снимается вместе с тегом, новая заводится без связи',
  remove: 'Запись останется в проекте со статусом «снята»; отмена импорта вернёт её',
  keep: 'Запись остаётся действующей, хотя в расчёте её нет',
};

function Row({ why, options, value, onPick, children }: {
  why: string; options: { value: string; label: string }[]; value: string;
  onPick: (v: string) => void; children?: React.ReactNode;
}) {
  return (
    <div className="px-3 py-2.5 border-b border-slate-200 dark:border-slate-800 last:border-b-0">
      <div className="text-sm text-slate-800 dark:text-white break-words">{why}</div>
      {children}
      <div className="mt-2 max-w-full overflow-x-auto">
        <Seg
          label="Что это за изделие"
          value={value}
          onChange={onPick}
          options={options.map(o => ({ value: o.value, label: o.label, hint: HINT[o.value] }))}
        />
      </div>
    </div>
  );
}

export default function MatchPanel({ matches, missing = [], systemRows, choices, onChange }: Props) {
  if (!matches.length && !systemRows.length && !missing.length) {
    return <div className="flex-1 flex items-center justify-center text-sm text-slate-400 p-8 text-center">Спорных позиций нет.</div>;
  }
  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="text-xs text-slate-500 mb-3">
        Спорных мест: <b>{matches.length + systemRows.length + missing.length}</b>. Умолчание уже выбрано; поправьте там, где программа ошиблась.
      </div>
      {systemRows.length > 0 && (
        <div className="mb-4 rounded-lg border border-slate-200 dark:border-slate-800">
          <div className="fx-gh px-3 py-1.5">Установки</div>
          {systemRows.map(r => (
            <Row key={r.key} why={r.why} options={r.options} value={choices[r.key] ?? r.choice} onPick={v => onChange(r.key, v)} />
          ))}
        </div>
      )}
      {missing.length > 0 && (
        <div className="mb-4 rounded-lg border border-slate-200 dark:border-slate-800">
          <div className="fx-gh px-3 py-1.5">Нет в расчёте — будет снято</div>
          {missing.map(m => (
            <Row key={m.key} why={`${m.systemName}: «${m.title}», ${m.at}`}
              options={[{ value: 'remove', label: 'Снять' }, { value: 'keep', label: 'Оставить' }]}
              value={choices[m.key] ?? (m.remove ? 'remove' : 'keep')} onPick={v => onChange(m.key, v)}>
              <div className="mt-1 text-xs text-slate-500 break-words">
                Позиция не удаляется: запись, тег и история остаются, в дереве она станет серой.
                {m.tags.length > 0 && <span className="font-mono"> · {m.tags.join(', ')}</span>}
              </div>
            </Row>
          ))}
        </div>
      )}
      {matches.length > 0 && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800">
          <div className="fx-gh px-3 py-1.5">Позиции</div>
          {matches.map(m => (
            <Row key={m.key} why={m.why} options={m.options} value={choices[m.key] ?? m.choice} onPick={v => onChange(m.key, v)}>
              <div className="mt-1 text-xs text-slate-500 break-words">
                <span>Было: {m.was.at} · {m.was.label}</span>
                {m.was.tags.length > 0 && <span className="font-mono"> · {m.was.tags.join(', ')}</span>}
              </div>
              <div className="text-xs text-slate-500 break-words">Стало: {m.at} · {m.now.label}</div>
            </Row>
          ))}
        </div>
      )}
    </div>
  );
}
