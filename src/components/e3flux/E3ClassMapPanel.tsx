/**
 * Связь типов Flux с основными классами классификатора (docs/e3-integration.md,
 * 5.2): по ней подбор знает, среди каких решений искать для позиции. Тип без
 * классов в схему не входит. Тип, который отвечает двум классам (вентилятор и
 * вентилятор ЕС), выбирает класс правилом `@class`. Пишется целиком, по версии
 * каталога.
 */
import React, { useMemo, useState } from 'react';
import { CLASSES } from '../../../equipment/classes';
import { e3SolutionsService as svc } from '../../services/e3SolutionsService';
import { Btn, Dialog, SectionHead } from '../ui';
import type { SolutionBookState } from './useSolutionBook';

const muted = 'text-slate-500 dark:text-slate-400';

function MapDialog({ title, selected, all, canEdit, busy, error, onSave, onClose }: {
  title: string; selected: string[]; all: string[]; canEdit: boolean; busy: boolean; error: string; onSave: (c: string[]) => void; onClose: () => void;
}) {
  const [on, setOn] = useState<string[]>(selected);
  const dirty = JSON.stringify([...on].sort()) !== JSON.stringify([...selected].sort());
  return (
    <Dialog title={title} onClose={onClose} busy={busy} scrollBody label={`Классы для типа ${title}`}
      footer={canEdit ? <><Btn onClick={onClose} disabled={busy}>Отмена</Btn><Btn tone="primary" disabled={!dirty || busy} onClick={() => onSave(on)}>Сохранить</Btn></> : <Btn onClick={onClose}>Закрыть</Btn>}>
      <p className={`mb-2 text-xs ${muted}`}>Среди решений каких основных классов искать для позиций этого типа. Без классов тип в схему не входит.</p>
      <div className="flex flex-col gap-1 text-sm">
        {all.map((c) => (
          <label key={c} className="flex items-center gap-2"><input type="checkbox" className="accent-emerald-600" checked={on.includes(c)} disabled={!canEdit || busy}
            onChange={() => setOn((l) => (l.includes(c) ? l.filter((x) => x !== c) : [...l, c]))} />{c}</label>
        ))}
      </div>
      {error && <p role="alert" className="fx-error mt-3">{error}</p>}
    </Dialog>
  );
}

export default function E3ClassMapPanel({ state, rights }: { state: SolutionBookState; rights: { edit: boolean } }) {
  const { book, error, busy, run } = state;
  const [editing, setEditing] = useState('');
  const [dialogError, setDialogError] = useState('');
  const map = book?.classMap || {};
  const files = useMemo(() => [...new Set([...(book?.solutions || []).map((s) => s.mainClass), ...(book?.features || []).map((f) => f.mainClass), ...Object.values(map).flat()].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru')), [book, map]);
  const countOf = (cls: string[]) => (book?.solutions || []).filter((s) => !s.removed && cls.includes(s.mainClass)).length;
  const close = () => { setEditing(''); setDialogError(''); };
  const save = async (type: string, classes: string[]) => {
    const next = { ...map, [type]: classes };
    if (!classes.length) delete next[type];
    if (await run((v) => svc.saveClassMap(next, v), setDialogError)) close();
  };
  const types = CLASSES.filter((c) => c.id !== 'ПРОЧЕЕ' || map[c.id]);

  return (
    <div className="fx-page min-w-0">
      <SectionHead title="Типы и классы" count={book ? `${Object.keys(map).length} из ${CLASSES.length} типов в схеме` : ''} />
      {error && !editing && <p role="alert" className="fx-error px-4 py-1">{error}</p>}
      {!book ? <p className={`p-4 text-sm ${muted}`}>{error ? '' : 'Загружаю каталог…'}</p> : (
        <div className="fx-page-body">
          <table className="fx-table text-left">
            <thead><tr><th>Тип Flux</th><th>Классы классификатора</th><th>Решений</th></tr></thead>
            <tbody>{types.map((t) => {
              const cls = map[t.id] || [];
              return (
                <tr key={t.id} tabIndex={0} role="button" className="cursor-pointer" onClick={() => { setDialogError(''); setEditing(t.id); }}
                  onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setDialogError(''); setEditing(t.id); } }}>
                  <td className="whitespace-nowrap">{t.title}</td>
                  <td className={`max-w-[360px] truncate ${cls.length ? '' : muted}`} title={cls.join(', ')}>{cls.length ? cls.join(', ') : 'не входит в схему'}</td>
                  <td className={`tabular-nums ${cls.length ? '' : muted}`}>{cls.length ? countOf(cls) : '—'}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
      {editing && book && <MapDialog key={`${editing}:${book.version}`} title={CLASSES.find((c) => c.id === editing)?.title || editing} selected={map[editing] || []} all={files}
        canEdit={rights.edit} busy={busy} error={dialogError} onSave={(c) => void save(editing, c)} onClose={close} />}
    </div>
  );
}
