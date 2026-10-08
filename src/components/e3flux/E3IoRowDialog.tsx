/**
 * Строка таблицы IO: сигналы по виду устройства и имя изделия E3, которое
 * ставится для этой строки. Имя изделия в файле владельца отсутствует — его
 * задаёт каталог. Поля из файла после правки здесь помечают строку правленой:
 * повторная загрузка файла их не перезапишет. Читатель каталога видит те же
 * поля без права менять.
 */
import React, { useState } from 'react';
import { IO_KEYS, IO_TITLES, ioRowId } from '../../../e3/ioTable';
import type { E3IoRow } from '../../../e3/solutionTypes';
import { Btn, Dialog, Field, Input } from '../ui';

const muted = 'text-slate-500 dark:text-slate-400';
const NUM = /^\d{0,4}$/;

export default function E3IoRowDialog({ row, existing, groups, canEdit, busy, error, onSave, onDelete, onClose }: {
  row: E3IoRow | null; existing: string[]; groups: string[]; canEdit: boolean; busy: boolean; error: string;
  onSave: (r: E3IoRow) => void; onDelete: () => void; onClose: () => void;
}) {
  const creating = !row;
  const [group, setGroup] = useState(row?.group || '');
  const [name, setName] = useState(row?.name || '');
  const [code, setCode] = useState(row?.code || '');
  const [nums, setNums] = useState<Record<string, string>>(() => Object.fromEntries(IO_KEYS.map((k) => [k, String(row?.[k] ?? 0)])));
  const [notes, setNotes] = useState({ di: row?.notes?.di || '', do: row?.notes?.do || '', ai: row?.notes?.ai || '', ao: row?.notes?.ao || '' });
  const [component, setComponent] = useState(row?.component || '');
  const off = !canEdit || busy;

  const id = row?.id || ioRowId(group, name);
  const next: E3IoRow = {
    id, group: group.trim(), name: name.trim(), code: code.trim(), di: Number(nums.di) || 0, do: Number(nums.do) || 0, ai: Number(nums.ai) || 0, ao: Number(nums.ao) || 0,
    notes, ...(component.trim() ? { component: component.trim() } : {}),
  };
  const dirty = creating || JSON.stringify({ ...next, edited: undefined }) !== JSON.stringify({ ...row, edited: undefined });
  const problem = !next.name ? 'Укажите наименование устройства' : creating && existing.includes(id) ? 'Такая строка (группа и наименование) уже есть' : '';

  return (
    <Dialog title={creating ? 'Новая строка таблицы IO' : <span>{row.name}</span>} onClose={onClose} busy={busy} width="max-w-2xl" scrollBody label={creating ? 'Новая строка таблицы IO' : `Строка таблицы IO: ${row.name}`}
      footer={canEdit ? <>
        {!creating && <Btn tone="danger" className="mr-auto" disabled={busy} onClick={onDelete}>Удалить строку</Btn>}
        <Btn onClick={onClose} disabled={busy}>Отмена</Btn>
        <Btn tone="primary" disabled={!dirty || !!problem || busy} title={problem || undefined} onClick={() => onSave(next)}>Сохранить</Btn>
      </> : <Btn onClick={onClose}>Закрыть</Btn>}>
      <div className="grid grid-cols-2 gap-x-3 gap-y-3">
        <Field label="Группа">
          <Input value={group} list="e3io-groups" disabled={off || !creating} onChange={(e) => setGroup(e.target.value)} aria-label="Группа" title={creating ? undefined : 'Группа входит в ключ строки и не меняется'} />
          <datalist id="e3io-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
        </Field>
        <Field label="Обозначение"><Input value={code} disabled={off} onChange={(e) => setCode(e.target.value)} placeholder="PT, PDT, TT" aria-label="Обозначение" className="font-mono" /></Field>
        <Field label="Наименование" className="col-span-2"><Input value={name} disabled={off || !creating} onChange={(e) => setName(e.target.value)} aria-label="Наименование" title={creating ? undefined : 'Наименование входит в ключ строки и не меняется'} /></Field>

        <div className="col-span-2">
          <div className="fx-label">Сигналы и их описание</div>
          <div className="mt-1 grid grid-cols-[48px_72px_1fr] items-center gap-x-3 gap-y-1.5 text-sm">
            {IO_KEYS.map((k) => (
              <React.Fragment key={k}>
                <span className="font-mono">{IO_TITLES[k]}</span>
                <Input value={nums[k]} inputMode="numeric" disabled={off} aria-label={`Число сигналов ${IO_TITLES[k]}`} className="tabular-nums" onChange={(e) => NUM.test(e.target.value) && setNums({ ...nums, [k]: e.target.value })} />
                <Input value={notes[k]} disabled={off} aria-label={`Описание ${IO_TITLES[k]}`} placeholder="описание сигнала" onChange={(e) => setNotes({ ...notes, [k]: e.target.value })} />
              </React.Fragment>
            ))}
          </div>
        </div>

        <Field label="Изделие E3" hint="Необязательная справка. Блок в E3 называется по названию схемы решения, а не по строке IO" className="col-span-2">
          <Input value={component} disabled={off} onChange={(e) => setComponent(e.target.value)} placeholder="клапан_DIx2_DOx1" aria-label="Изделие E3" className="font-mono" />
        </Field>
      </div>
      {row?.edited && <p className={`mt-3 text-xs ${muted}`}>Поля из файла правили вручную: повторная загрузка файла их не перезапишет.</p>}
      {problem && <p className="fx-hint mt-3">{problem}</p>}
      {error && <p role="alert" className="fx-error mt-3">{error}</p>}
    </Dialog>
  );
}
