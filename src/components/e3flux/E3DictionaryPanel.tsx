/**
 * Словарь обозначений (docs/e3-integration.md, 5.2): код из названия схемы →
 * что он значит. По нему Flux разбирает названия решений на признаки. Словарь —
 * настройка каталога: загрузка файла добавляет только новые коды, а правки
 * делаются здесь. Пишется целиком, по версии каталога.
 */
import React, { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import type { E3Dictionary } from '../../../e3/solutionTypes';
import { e3SolutionsService as svc } from '../../services/e3SolutionsService';
import { count } from '../../lib/plural';
import { Btn, Dialog, Empty, Field, Input, SectionHead, Toolbar } from '../ui';
import type { SolutionBookState } from './useSolutionBook';

const muted = 'text-slate-500 dark:text-slate-400';

function CodeDialog({ code, text, taken, canEdit, busy, error, onSave, onDelete, onClose }: {
  code: string; text: string; taken: (c: string) => boolean; canEdit: boolean; busy: boolean; error: string;
  onSave: (code: string, text: string) => void; onDelete: () => void; onClose: () => void;
}) {
  const creating = !code;
  const [c, setC] = useState(code);
  const [d, setD] = useState(text);
  const problem = !c.trim() ? 'Укажите обозначение, например ПЧИ' : creating && taken(c.trim()) ? 'Такое обозначение уже есть' : !d.trim() ? 'Опишите, что оно значит' : '';
  const dirty = creating || d !== text;
  return (
    <Dialog title={creating ? 'Новое обозначение' : <span className="font-mono">{code}</span>} onClose={onClose} busy={busy} label="Обозначение" scrollBody
      footer={canEdit ? <>
        {!creating && <Btn tone="danger" className="mr-auto" disabled={busy} onClick={onDelete}>Удалить</Btn>}
        <Btn onClick={onClose} disabled={busy}>Отмена</Btn>
        <Btn tone="primary" disabled={!dirty || !!problem || busy} title={problem || undefined} onClick={() => onSave(c.trim(), d.trim())}>Сохранить</Btn>
      </> : <Btn onClick={onClose}>Закрыть</Btn>}>
      <div className="flex flex-col gap-3">
        <Field label="Обозначение"><Input value={c} onChange={(e) => setC(e.target.value)} disabled={!creating} aria-label="Обозначение" className="font-mono" /></Field>
        <Field label="Что значит"><Input value={d} onChange={(e) => setD(e.target.value)} disabled={!canEdit || busy} aria-label="Что значит" /></Field>
      </div>
      {problem && <p className="fx-hint mt-3">{problem}</p>}
      {error && <p role="alert" className="fx-error mt-3">{error}</p>}
    </Dialog>
  );
}

export default function E3DictionaryPanel({ state, rights }: { state: SolutionBookState; rights: { edit: boolean } }) {
  const { book, error, busy, run } = state;
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<string | null>(null); // '' — новое
  const [dialogError, setDialogError] = useState('');
  const dict: E3Dictionary = book?.dictionary || {};
  const rows = useMemo(() => {
    const low = q.trim().toLocaleLowerCase('ru');
    return Object.entries(dict).filter(([c, d]) => !low || c.toLocaleLowerCase('ru').includes(low) || d.toLocaleLowerCase('ru').includes(low));
  }, [dict, q]);
  const total = Object.keys(dict).length;
  const close = () => { setEditing(null); setDialogError(''); };

  const write = async (next: E3Dictionary) => { if (await run((v) => svc.saveDictionary(next, v), setDialogError)) close(); };
  const save = (code: string, text: string) => write({ ...dict, [code]: text });
  const remove = () => { const { [editing as string]: _gone, ...rest } = dict; return write(rest); };

  return (
    <div className="fx-page min-w-0">
      <SectionHead title="Обозначения" count={total ? count(total, 'обозначение', 'обозначения', 'обозначений') : ''}
        actions={rights.edit && <Btn tone="primary" disabled={busy || !book} onClick={() => { setDialogError(''); setEditing(''); }}><Plus className="w-3.5 h-3.5" /> Добавить обозначение</Btn>} />
      {error && editing === null && <p role="alert" className="fx-error px-4 py-1">{error}</p>}
      {!book ? <p className={`p-4 text-sm ${muted}`}>{error ? '' : 'Загружаю каталог…'}</p> : !total ? <div className="p-4"><Empty title="Словарь пуст" text="Он наполняется листом «Обозначения» при загрузке классификатора или вручную." /></div> : <>
        <Toolbar><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Обозначение или описание" aria-label="Поиск обозначения" className="max-w-[360px] flex-1" /></Toolbar>
        <div className="fx-page-body">
          {!rows.length ? <div className="p-4"><Empty title="Ничего не найдено" text="Измените поиск." /></div> : (
            <table className="fx-table text-left">
              <thead><tr><th>Обозначение</th><th>Что значит</th></tr></thead>
              <tbody>{rows.map(([c, d]) => (
                <tr key={c} tabIndex={0} role="button" className="cursor-pointer" onClick={() => { setDialogError(''); setEditing(c); }}
                  onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setDialogError(''); setEditing(c); } }}>
                  <td className="whitespace-nowrap font-mono">{c}</td>
                  <td className="max-w-[640px] truncate" title={d}>{d}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      </>}
      {editing !== null && book && (editing === '' || editing in dict) && <CodeDialog key={`${editing}:${book.version}`} code={editing} text={dict[editing] || ''} taken={(c) => c in dict}
        canEdit={rights.edit} busy={busy} error={dialogError} onSave={(c, t) => void save(c, t)} onDelete={() => void remove()} onClose={close} />}
    </div>
  );
}
