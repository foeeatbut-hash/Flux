/** Окна «добавить»: тип оборудования, изготовитель, модель, подтип. Каждое хранит свои поля и пишет в черновики через catalogService. */
import React, { useState } from 'react';
import { Dialog } from '../ui';
import { useToastStore } from '../../store/toastStore';
import { catalogService } from '../../services/catalogService';
import type { Catalog, EquipmentClass, Family, Manufacturer } from '../../../catalog/model';
import { textOf, t2 } from '../../../catalog/model';
import { Btn, Field, Input, Select } from './ui';

export const EQUIPMENT_TYPES = [
  { title: 'Вентилятор', item: 'вентилятор' }, { title: 'Вентиляционная установка', item: 'вентиляционная установка' },
  { title: 'Насос', item: 'насос' }, { title: 'Теплообменник', item: 'теплообменник' },
  { title: 'Клапан', item: 'клапан' }, { title: 'Привод', item: 'привод' },
  { title: 'Автоматика', item: 'устройство автоматики' }, { title: 'Произвольный тип', item: '' },
];
export type EquipmentPreset = typeof EQUIPMENT_TYPES[number];
export const idFor = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
const slug = (s: string, max: number) => s.toLocaleLowerCase('ru').replace(/[^a-zа-я0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, max);

export function blankFamily(cls: EquipmentClass, manufacturerId: string, code: string, title: string, kind: string): Family {
  return {
    id: idFor('fam'), classId: cls.id, manufacturerId, code, title: t2(title), kind,
    typeLabel: t2(textOf(cls.itemName)), shapes: [], params: [],
    positions: [{ key: 'series', label: t2('Обозначение'), formats: [code] }],
    rules: [], match: { kinds: [kind] }, specs: [], status: 'draft', examples: [], sort: 999,
  };
}

/** Общий каркас: save() пишет, при успехе — тост и onDone, при ошибке — тост и окно остаётся */
function useSubmit(done: string, fail: string, onClose: () => void) {
  const addToast = useToastStore((s) => s.addToast);
  const [busy, setBusy] = useState(false);
  const run = async (save: () => Promise<void>) => {
    setBusy(true);
    try { await save(); addToast(done, 'success'); onClose(); }
    catch (e: any) { addToast(e?.message || fail, 'error'); }
    finally { setBusy(false); }
  };
  return { busy, run };
}

export function ClassDialog({ catalog, preset, onClose, onDone }: { catalog: Catalog; preset?: EquipmentPreset; onClose: () => void; onDone: (id: string) => Promise<void> }) {
  const [title, setTitle] = useState(preset && preset.title !== 'Произвольный тип' ? preset.title : '');
  const [item, setItem] = useState(preset?.item || '');
  const { busy, run } = useSubmit('Тип оборудования добавлен', 'Не удалось добавить тип', onClose);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !item.trim()) return;
    const id = idFor('cls');
    const c: EquipmentClass = {
      id, code: `${slug(title.trim(), 18) || 'equipment'}-${id.slice(-5)}`, title: t2(title.trim()), itemName: t2(item.trim()),
      facts: [{ key: 'kind', label: t2('Подтип'), type: 'choice', hard: true, values: [{ code: 'default', label: t2(title.trim()) }] }],
      sort: catalog.classes.length + 1,
    };
    void run(async () => { await catalogService.save('class', c); await onDone(c.id); });
  };
  return <Dialog title="Новый тип оборудования" onClose={onClose} busy={busy} width="max-w-lg"
    footer={<><Btn onClick={onClose} disabled={busy}>Отмена</Btn><Btn tone="primary" type="submit" form="cat-class-form" disabled={busy || !title.trim() || !item.trim()}>Добавить тип</Btn></>}>
    <form id="cat-class-form" onSubmit={submit} className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1">{EQUIPMENT_TYPES.map((p) => <Btn key={p.title} size="sm" tone="ghost" onClick={() => { setTitle(p.title === 'Произвольный тип' ? '' : p.title); setItem(p.item); }}>{p.title}</Btn>)}</div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Тип оборудования"><Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например, насос" required /></Field>
        <Field label="Название одной позиции"><Input value={item} onChange={(e) => setItem(e.target.value)} placeholder="Например, насос" required /></Field>
      </div>
      <p className="fx-hint m-0">Новый тип появится после сохранения. Подтипы и характеристики можно настроить в карточках моделей.</p>
    </form>
  </Dialog>;
}

export function ManufacturerDialog({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => Promise<void> }) {
  const [m, setM] = useState<Manufacturer>({ id: idFor('mf'), name: '', shortName: '' });
  const { busy, run } = useSubmit('Изготовитель добавлен', 'Не удалось добавить изготовителя', onClose);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const item = { ...m, name: m.name.trim(), shortName: m.shortName.trim() };
    if (!item.name || !item.shortName) return;
    void run(async () => { await catalogService.save('manufacturer', item); await onDone(item.id); });
  };
  return <Dialog title="Новый изготовитель" onClose={onClose} busy={busy}
    footer={<><Btn onClick={onClose} disabled={busy}>Отмена</Btn><Btn tone="primary" type="submit" form="cat-maker-form" disabled={busy || !m.name.trim() || !m.shortName.trim()}>Добавить изготовителя</Btn></>}>
    <form id="cat-maker-form" onSubmit={submit} className="flex flex-col gap-3">
      <Field label="Полное название"><Input autoFocus value={m.name} onChange={(e) => setM({ ...m, name: e.target.value })} placeholder="ООО «Пример»" required /></Field>
      <Field label="Короткое название"><Input value={m.shortName} onChange={(e) => setM({ ...m, shortName: e.target.value })} placeholder="Пример" required /></Field>
    </form>
  </Dialog>;
}

export function FamilyDialog({ catalog, cls, manufacturerId, onClose, onDone }: { catalog: Catalog; cls: EquipmentClass; manufacturerId: string; onClose: () => void; onDone: (id: string) => Promise<void> }) {
  const [maker, setMaker] = useState(manufacturerId || catalog.manufacturers[0]?.id || '');
  const [kind, setKind] = useState(cls.facts.find((f) => f.key === 'kind')?.values?.[0]?.code || '');
  const [code, setCode] = useState(''); const [title, setTitle] = useState('');
  const { busy, run } = useSubmit('Модель добавлена. Характеристики можно заполнить в карточке.', 'Не удалось добавить модель', onClose);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim() || !title.trim() || !maker) return;
    const item = blankFamily(cls, maker, code.trim(), title.trim(), kind || 'default');
    void run(async () => { await catalogService.save('family', item); await onDone(item.id); });
  };
  return <Dialog title={`Новая модель · ${textOf(cls.title)}`} onClose={onClose} busy={busy} width="max-w-lg"
    footer={<><Btn onClick={onClose} disabled={busy}>Отмена</Btn><Btn tone="primary" type="submit" form="cat-family-form" disabled={busy || !maker || !code.trim() || !title.trim()}>Добавить модель</Btn></>}>
    <form id="cat-family-form" onSubmit={submit} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Изготовитель"><Select value={maker} onChange={setMaker} options={catalog.manufacturers.map((m) => ({ value: m.id, label: m.name }))} /></Field>
        <Field label="Подтип"><Select value={kind} onChange={setKind} options={(cls.facts.find((f) => f.key === 'kind')?.values || []).map((v) => ({ value: v.code, label: textOf(v.label) }))} /></Field>
        <Field label="Марка или код"><Input autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="Например, ВКРС" required /></Field>
        <Field label="Название модели"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например, вентилятор радиальный" required /></Field>
      </div>
      <p className="fx-hint m-0">После создания заполните обозначение, параметры и характеристики в карточке модели.</p>
    </form>
  </Dialog>;
}

export function SubtypeDialog({ cls, onClose, onDone }: { cls: EquipmentClass; onClose: () => void; onDone: () => Promise<void> }) {
  const [title, setTitle] = useState('');
  const { busy, run } = useSubmit('Подтип добавлен', 'Не удалось добавить подтип', onClose);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const at = cls.facts.findIndex((f) => f.key === 'kind');
    const existing = at >= 0 ? cls.facts[at] : { key: 'kind', label: t2('Подтип'), type: 'choice' as const, hard: true, values: [] };
    const codes = new Set((existing.values || []).map((v) => v.code));
    const base = slug(title.trim(), 24) || 'subtype';
    let code = base; let n = 2;
    while (codes.has(code)) code = `${base}-${n++}`;
    const facts = [...cls.facts];
    const next = { ...existing, values: [...(existing.values || []), { code, label: t2(title.trim()) }] };
    if (at >= 0) facts[at] = next; else facts.push(next);
    void run(async () => { await catalogService.save('class', { ...cls, facts }); await onDone(); });
  };
  const known = (cls.facts.find((f) => f.key === 'kind')?.values || []).map((v) => textOf(v.label)).join(', ');
  return <Dialog title={`Подтип · ${textOf(cls.title)}`} onClose={onClose} busy={busy}
    footer={<><Btn onClick={onClose} disabled={busy}>Отмена</Btn><Btn tone="primary" type="submit" form="cat-subtype-form" disabled={busy || !title.trim()}>Добавить подтип</Btn></>}>
    <form id="cat-subtype-form" onSubmit={submit} className="flex flex-col gap-3">
      <Field label="Название подтипа"><Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например, дымовой" required /></Field>
      <p className="fx-hint m-0">Существующие подтипы: {known || 'пока нет'}</p>
    </form>
  </Dialog>;
}
