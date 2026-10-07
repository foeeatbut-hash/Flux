/**
 * Правила признаков (docs/e3-integration.md, 5.3): «как из данных позиции
 * получить ответ на признак». Строка таблицы — «значение → ответ»; значение
 * целиком (числа сравниваются как числа) или `~часть` (содержит); первое
 * совпадение выигрывает, поэтому порядок строк важен.
 */
import React, { useState } from 'react';
import { Plus } from 'lucide-react';
import { E3_FIELD_KEYS, E3_FIELD_TITLES } from '../../../e3/attributes';
import type { E3FeatureRule, E3RuleSource } from '../../../e3/solutionTypes';
import { e3SolutionsService as svc } from '../../services/e3SolutionsService';
import { count } from '../../lib/plural';
import { Area, Btn, Dialog, Empty, Field, Input, SectionHead, Select } from '../ui';
import { confirmAsk } from '../catalog/ui';
import { ruleSourceText, ruleTableText } from './e3SolutionText';
import type { SolutionBookState } from './useSolutionBook';

const muted = 'text-slate-500 dark:text-slate-400';
const KINDS: Array<{ value: E3RuleSource['kind']; label: string }> = [
  { value: 'field', label: 'поле позиции' }, { value: 'param', label: 'характеристика позиции' }, { value: 'count', label: 'число подпозиций роли' },
  { value: 'child-param', label: 'характеристика подпозиции' }, { value: 'child-field', label: 'поле подпозиции' },
];
const ARROW = /\s*(?:→|->|=>)\s*/;

/** «значение → ответ» по строке; пустой ответ допустим («нет данных»), пустое значение — нет */
const parseTable = (t: string) => t.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [when, ...rest] = l.split(ARROW); return { when: when.trim(), answer: rest.join(' → ').trim() }; });
const tableText = (r?: E3FeatureRule) => (r?.table || []).map((t) => `${t.when} → ${t.answer}`).join('\n');

function RuleDialog({ rule, classes, featuresOf, canEdit, busy, error, onSave, onDelete, onClose }: {
  rule: E3FeatureRule | null; classes: string[]; featuresOf: (cls: string) => Array<{ id: string; title: string }>;
  canEdit: boolean; busy: boolean; error: string; onSave: (r: E3FeatureRule) => void; onDelete: () => void; onClose: () => void;
}) {
  const creating = !rule;
  const s = rule?.source;
  const [mainClass, setMainClass] = useState(rule?.mainClass || classes[0] || '');
  const [featureId, setFeatureId] = useState(rule?.featureId || '');
  const [kind, setKind] = useState<E3RuleSource['kind']>(s?.kind || 'param');
  const [key, setKey] = useState<string>(s && 'key' in s ? s.key : 'tag');
  const [name, setName] = useState(s && 'name' in s ? s.name : '');
  const [unit, setUnit] = useState(s && 'unit' in s ? s.unit || '' : '');
  const [role, setRole] = useState(s && 'role' in s ? s.role : '');
  const [table, setTable] = useState(tableText(rule || undefined));
  const [otherwise, setOtherwise] = useState(rule?.otherwise || '');
  const feats = [...(featuresOf(mainClass)), { id: '@class', title: 'Выбор основного класса (@class)' }];
  const source = ((): E3RuleSource => {
    const u = unit.trim() ? { unit: unit.trim() } : {};
    if (kind === 'field') return { kind, key: key as any };
    if (kind === 'param') return { kind, name: name.trim(), ...u };
    if (kind === 'count') return { kind, role: role.trim() };
    if (kind === 'child-param') return { kind, role: role.trim(), name: name.trim(), ...u };
    return { kind, role: role.trim(), key: key as any };
  })();
  const rows = parseTable(table);
  const next: E3FeatureRule = { mainClass, featureId, source, table: rows, ...(otherwise.trim() ? { otherwise: otherwise.trim() } : {}) };
  const needName = (kind === 'param' || kind === 'child-param') && !name.trim();
  const needRole = kind !== 'field' && kind !== 'param' && !role.trim();
  const problem = !featureId ? 'Выберите признак' : needName ? 'Назовите характеристику — например «Напряжение»' : needRole ? 'Укажите роль подпозиции — например «ДВИГАТЕЛЬ»'
    : rows.some((r) => !r.when) ? 'В каждой строке таблицы нужно значение слева от «→»' : '';
  const dirty = creating || JSON.stringify(next) !== JSON.stringify(rule);
  const off = !canEdit || busy;
  return (
    <Dialog title={creating ? 'Новое правило' : `${rule.mainClass} · ${rule.featureId}`} onClose={onClose} busy={busy} width="max-w-xl" scrollBody label="Правило признака"
      footer={canEdit ? <>
        {!creating && <Btn tone="danger" className="mr-auto" disabled={busy} onClick={onDelete}>Удалить правило</Btn>}
        <Btn onClick={onClose} disabled={busy}>Отмена</Btn>
        <Btn tone="primary" disabled={!dirty || !!problem || busy} title={problem || undefined} onClick={() => onSave(next)}>Сохранить</Btn>
      </> : <Btn onClick={onClose}>Закрыть</Btn>}>
      <div className="grid grid-cols-2 gap-x-3 gap-y-3">
        <Field label="Основной класс">
          {creating ? <Select value={mainClass} onChange={(v) => { setMainClass(v); setFeatureId(''); }} aria-label="Основной класс" options={classes.map((c) => ({ value: c, label: c }))} /> : <Input value={mainClass} disabled aria-label="Основной класс" />}
        </Field>
        <Field label="Признак">
          {creating ? <Select value={featureId} onChange={setFeatureId} aria-label="Признак" options={[{ value: '', label: 'выберите' }, ...feats.map((f) => ({ value: f.id, label: f.title }))]} /> : <Input value={featureId} disabled aria-label="Признак" className="font-mono" />}
        </Field>
        <Field label="Откуда читать" className="col-span-2"><Select value={kind} onChange={(v) => setKind(v as E3RuleSource['kind'])} disabled={off} aria-label="Откуда читать" options={KINDS} /></Field>
        {(kind === 'field' || kind === 'child-field') && <Field label="Поле"><Select value={key} onChange={setKey} disabled={off} aria-label="Поле" options={E3_FIELD_KEYS.map((k) => ({ value: k, label: E3_FIELD_TITLES[k] }))} /></Field>}
        {kind !== 'field' && kind !== 'param' && <Field label="Роль подпозиции"><Input value={role} onChange={(e) => setRole(e.target.value)} disabled={off} placeholder="ДВИГАТЕЛЬ" aria-label="Роль подпозиции" /></Field>}
        {(kind === 'param' || kind === 'child-param') && <>
          <Field label="Характеристика"><Input value={name} onChange={(e) => setName(e.target.value)} disabled={off} placeholder="Напряжение" aria-label="Характеристика" /></Field>
          <Field label="Единица"><Input value={unit} onChange={(e) => setUnit(e.target.value)} disabled={off} placeholder="В" aria-label="Единица" /></Field>
        </>}
        <Field label="Таблица: «значение → ответ», по строке" hint="~часть — содержит; первое совпадение выигрывает" className="col-span-2">
          <Area rows={6} value={table} onChange={(e) => setTable(e.target.value)} disabled={off} aria-label="Таблица ответов" className="font-mono" />
        </Field>
        <Field label="Иначе (если ничего не подошло или данных нет)" className="col-span-2"><Input value={otherwise} onChange={(e) => setOtherwise(e.target.value)} disabled={off} aria-label="Иначе" /></Field>
      </div>
      {problem && <p className="fx-hint mt-3">{problem}</p>}
      {error && <p role="alert" className="fx-error mt-3">{error}</p>}
    </Dialog>
  );
}

export default function E3RulesPanel({ state, rights }: { state: SolutionBookState; rights: { edit: boolean } }) {
  const { book, error, busy, run } = state;
  const [editing, setEditing] = useState<string | null>(null); // 'класс|признак'; '' — новое
  const [dialogError, setDialogError] = useState('');
  const rules = book?.rules || [];
  const idOf = (r: E3FeatureRule) => `${r.mainClass}|${r.featureId}`;
  const editingRule = editing ? rules.find((r) => idOf(r) === editing) || null : null;
  const classes = [...new Set((book?.features || []).map((f) => f.mainClass))].sort((a, b) => a.localeCompare(b, 'ru'));
  const titleOf = (r: E3FeatureRule) => (book?.features || []).find((f) => f.id === r.featureId)?.title || (r.featureId === '@class' ? 'Выбор основного класса' : r.featureId);
  const close = () => { setEditing(null); setDialogError(''); };

  const save = async (r: E3FeatureRule) => { if (await run((v) => svc.saveRule(r, v), setDialogError)) close(); };
  const remove = async () => {
    if (!editingRule) return;
    if (!(await confirmAsk('Удалить правило?', `Признак «${titleOf(editingRule)}» (${editingRule.mainClass}) перестанет получать ответ из данных позиции — его возьмёт профиль проекта или спросит человек.`, { confirmLabel: 'Удалить', tone: 'danger' }))) return;
    if (await run((v) => svc.deleteRule(editingRule, v), setDialogError)) close();
  };

  return (
    <div className="fx-page min-w-0">
      <SectionHead title="Правила признаков" count={rules.length ? count(rules.length, 'правило', 'правила', 'правил') : ''}
        actions={rights.edit && <Btn tone="primary" disabled={busy || !book} onClick={() => { setDialogError(''); setEditing(''); }}><Plus className="w-3.5 h-3.5" /> Добавить правило</Btn>} />
      {error && editing === null && <p role="alert" className="fx-error px-4 py-1">{error}</p>}
      {!book ? <p className={`p-4 text-sm ${muted}`}>{error ? '' : 'Загружаю каталог…'}</p> : !rules.length ? <div className="p-4"><Empty title="Правил нет" text="Правило берёт ответ на признак из подбора ОВ: например, напряжение привода клапана." /></div> : (
        <div className="fx-page-body">
          <table className="fx-table text-left">
            <thead><tr><th>Класс</th><th>Признак</th><th>Откуда читать</th><th>Таблица ответов</th></tr></thead>
            <tbody>{rules.map((r) => (
              <tr key={idOf(r)} tabIndex={0} role="button" className="cursor-pointer" onClick={() => { setDialogError(''); setEditing(idOf(r)); }}
                onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setDialogError(''); setEditing(idOf(r)); } }}>
                <td className="whitespace-nowrap">{r.mainClass}</td>
                <td className="max-w-[240px] truncate" title={r.featureId}>{titleOf(r)}</td>
                <td className="max-w-[260px] truncate" title={ruleSourceText(r.source)}>{ruleSourceText(r.source)}</td>
                <td className="max-w-[300px] truncate font-mono" title={ruleTableText(r)}>{ruleTableText(r)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {editing !== null && book && (editing === '' || editingRule) && <RuleDialog key={`${editing}:${book.version}`} rule={editingRule} classes={classes}
        featuresOf={(c) => book.features.filter((f) => f.mainClass === c)} canEdit={rights.edit} busy={busy} error={dialogError} onSave={(r) => void save(r)} onDelete={() => void remove()} onClose={close} />}
    </div>
  );
}
