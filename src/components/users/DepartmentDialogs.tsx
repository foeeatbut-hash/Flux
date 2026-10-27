import React, { useMemo, useState } from 'react';
import { Btn, Dialog, Field, Input, Select } from '../ui';
import DepartmentPicker from './DepartmentPicker';
import { KIND_LABEL, canNest } from '../../../shared/departments';
import { departmentService, type DepartmentRow } from '../../services/departmentService';
import { useDepartmentStore } from '../../store/departmentStore';
import { countOf } from '../../lib/plural';

// Часовые пояса России — первыми: ими пользуются чаще всего; остальные IANA — за ними
const RU_ZONES = ['Europe/Kaliningrad', 'Europe/Moscow', 'Europe/Samara', 'Asia/Yekaterinburg', 'Asia/Omsk', 'Asia/Novosibirsk', 'Asia/Krasnoyarsk', 'Asia/Irkutsk', 'Asia/Yakutsk', 'Asia/Vladivostok', 'Asia/Magadan', 'Asia/Kamchatka'];
function allZones(): string[] {
  try {
    const all = (Intl as any).supportedValuesOf?.('timeZone') as string[] | undefined;
    return all?.length ? [...RU_ZONES, ...all.filter((z) => !RU_ZONES.includes(z))] : RU_ZONES;
  } catch { return RU_ZONES; }
}

/** Создание подразделения внутри выбранного и правка названия, города, пояса и вида. */
export function DepartmentFormDialog({ mode, dept, parent, departments, onClose, onDone }: {
  mode: 'create' | 'edit'; dept?: DepartmentRow; parent?: DepartmentRow; departments: DepartmentRow[];
  onClose: () => void; onDone: (id: string) => void;
}) {
  const holder = mode === 'create' ? parent : departments.find((d) => d.id === dept?.parentId);
  const kids = departments.filter((d) => d.parentId === dept?.id);
  const kinds = (['branch', 'division', 'group'] as const).filter((k) => !holder || (canNest(holder.kind, k) && kids.every((c) => canNest(k, c.kind))));
  const firstKind = holder?.kind === 'company' ? 'branch' : holder?.kind === 'branch' ? 'division' : 'group';
  const [name, setName] = useState(dept?.name || '');
  const [kind, setKind] = useState(dept?.kind || (kinds.includes(firstKind) ? firstKind : kinds[0] || 'division'));
  const [city, setCity] = useState(dept?.city || '');
  const [timezone, setTimezone] = useState(dept?.timezone || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const zones = useMemo(allZones, []);
  const isRoot = dept?.kind === 'company';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError('Укажите название подразделения'); return; }
    setBusy(true); setError('');
    try {
      const body = { name: name.trim(), city: city.trim(), timezone: timezone.trim() };
      const saved = mode === 'create'
        ? await departmentService.create({ ...body, parentId: parent?.id, kind })
        : await departmentService.update(dept!.id, { ...body, ...(isRoot || kind === dept!.kind ? {} : { kind }) });
      await useDepartmentStore.getState().load();
      onDone(saved.id);
    } catch (err: any) { setError(err?.message || 'Не удалось сохранить'); }
    finally { setBusy(false); }
  };

  return <Dialog title={mode === 'create' ? `Новое подразделение${parent ? ` в «${parent.name}»` : ''}` : 'Подразделение'} onClose={onClose} busy={busy}
    footer={<><Btn size="lg" disabled={busy} onClick={onClose}>Отмена</Btn><Btn size="lg" tone="primary" type="submit" form="department-form" disabled={busy}>{busy ? 'Сохранение…' : mode === 'create' ? 'Создать' : 'Сохранить'}</Btn></>}>
    {error && <p className="fx-error mb-3">{error}</p>}
    <form id="department-form" onSubmit={submit} className="space-y-3">
      <Field label="Название"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} disabled={busy} placeholder="Например, ОВиК" /></Field>
      {!isRoot && <Field label="Вид" hint="Город — прямо в компании, группа — необязательный уровень внутри отдела.">
        <Select value={kind} onChange={setKind} disabled={busy || kinds.length < 2} options={kinds.map((k) => ({ value: k, label: KIND_LABEL[k] }))} />
      </Field>}
      <Field label="Город"><Input value={city} onChange={(e) => setCity(e.target.value)} disabled={busy} placeholder="Для города — его название" /></Field>
      <Field label="Часовой пояс" hint="Формат IANA, например Asia/Novosibirsk. Нужен для расписаний по местному времени.">
        <Input list="department-zones" value={timezone} onChange={(e) => setTimezone(e.target.value)} disabled={busy} placeholder="Asia/Novosibirsk" className="code" />
        <datalist id="department-zones">{zones.map((z) => <option key={z} value={z} />)}</datalist>
      </Field>
    </form>
  </Dialog>;
}

/** Архив подразделения: пока в нём есть люди, нужно сказать, куда их перевести. */
export function ArchiveDialog({ dept, departments, onClose, onDone }: {
  dept: DepartmentRow; departments: DepartmentRow[]; onClose: () => void; onDone: (message: string, undoToken: string) => void;
}) {
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const people = dept.total;
  const submit = async () => {
    if (people && !target) { setError('Выберите, куда перевести людей'); return; }
    setBusy(true); setError('');
    try {
      const r = await departmentService.archive(dept.id, people ? target : undefined);
      await useDepartmentStore.getState().load();
      onDone(`«${dept.name}» отправлено в архив${r.moved ? `, переведено: ${countOf(r.moved, 'сотрудник')}` : ''}`, r.undoToken);
    } catch (err: any) { setError(err?.message || 'Не удалось отправить в архив'); }
    finally { setBusy(false); }
  };
  return <Dialog title={`В архив: «${dept.name}»`} onClose={onClose} busy={busy}
    footer={<><Btn size="lg" disabled={busy} onClick={onClose}>Отмена</Btn><Btn size="lg" tone="danger" disabled={busy} onClick={() => void submit()}>{busy ? 'Выполняется…' : 'Отправить в архив'}</Btn></>}>
    {error && <p className="fx-error mb-3">{error}</p>}
    <p className="mb-3">Подразделение не удаляется: его можно вернуть из архива, история переводов сохранится. Вложенные подразделения уходят в архив вместе с ним.</p>
    {people > 0
      ? <Field label={`Куда перевести людей (${countOf(people, 'сотрудник')})`} hint="Переводятся все, кто в этом подразделении и во вложенных. Перевод можно отменить сразу после.">
          <DepartmentPicker value={target} onChange={setTarget} departments={departments} exclude={dept.id} disabled={busy} ariaLabel="Куда перевести людей" />
        </Field>
      : <p className="fx-hint">Людей здесь нет — перевод не нужен.</p>}
  </Dialog>;
}
