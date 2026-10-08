/**
 * Признаки типовых решений (docs/e3-integration.md, 5.2): вопрос с вариантами
 * ответа, общий для решений одного класса. Признак — настройка каталога: его
 * правят здесь, а не в файле. Удаление признака убирает и его правила — иначе
 * они остались бы без вопроса.
 */
import React, { useMemo, useState } from 'react';
import { useJump, type JumpProps } from './e3Jump';
import { Plus } from 'lucide-react';
import type { E3Feature, E3FeatureKind } from '../../../e3/solutionTypes';
import { missingCount } from '../../../e3/solutionMissing';
import { e3SolutionsService as svc } from '../../services/e3SolutionsService';
import { useToastStore } from '../../store/toastStore';
import { count } from '../../lib/plural';
import { Area, Btn, Dialog, Empty, Field, Input, SectionHead, Select, Toolbar } from '../ui';
import { confirmAsk } from '../catalog/ui';
import { KIND_TITLES } from './e3SolutionText';
import type { SolutionBookState } from './useSolutionBook';

const muted = 'text-slate-500 dark:text-slate-400';
const split = (t: string): string[] => [...new Set(t.split(/[\n,;]/).map((v) => v.trim()).filter(Boolean))];

function FeatureDialog({ feature, classes, canEdit, busy, error, onSave, onDelete, onClose }: {
  feature: E3Feature | null; classes: string[]; canEdit: boolean; busy: boolean; error: string; onSave: (f: E3Feature) => void; onDelete: () => void; onClose: () => void;
}) {
  const creating = !feature;
  const [id, setId] = useState(feature?.id || '');
  const [mainClass, setMainClass] = useState(feature?.mainClass || classes[0] || '');
  const [title, setTitle] = useState(feature?.title || '');
  const [values, setValues] = useState((feature?.values || []).join('\n'));
  const [kind, setKind] = useState<E3FeatureKind>(feature?.kind || 'ov');
  const [hint, setHint] = useState(feature?.hint || '');
  const [absent, setAbsent] = useState(feature?.absent || '');
  const list = split(values);
  const next: E3Feature = { id: id.trim(), mainClass: mainClass.trim(), title: title.trim(), values: list, kind, hint: hint.trim(), ...(absent ? { absent } : {}) };
  const problem = !next.id ? 'Укажите id признака латиницей через точку, например valve.drive' : !next.mainClass ? 'Укажите основной класс' : !next.title ? 'Назовите признак' : !list.length ? 'Перечислите варианты ответа' : '';
  const dirty = creating || JSON.stringify(next) !== JSON.stringify(feature);
  const off = !canEdit || busy;
  return (
    <Dialog title={creating ? 'Новый признак' : feature.title} onClose={onClose} busy={busy} width="max-w-xl" scrollBody label={creating ? 'Новый признак' : `Признак ${feature.id}`}
      footer={canEdit ? <>
        {!creating && <Btn tone="danger" className="mr-auto" disabled={busy} onClick={onDelete}>Удалить признак</Btn>}
        <Btn onClick={onClose} disabled={busy}>Отмена</Btn>
        <Btn tone="primary" disabled={!dirty || !!problem || busy} title={problem || undefined} onClick={() => onSave(next)}>Сохранить</Btn>
      </> : <Btn onClick={onClose}>Закрыть</Btn>}>
      <div className="grid grid-cols-2 gap-x-3 gap-y-3">
        <Field label="Id признака"><Input value={id} onChange={(e) => setId(e.target.value)} disabled={!creating} placeholder="valve.drive" aria-label="Id признака" className="font-mono" /></Field>
        <Field label="Основной класс">
          {creating ? <Select value={mainClass} onChange={setMainClass} aria-label="Основной класс" options={classes.map((c) => ({ value: c, label: c }))} /> : <Input value={mainClass} disabled aria-label="Основной класс" />}
        </Field>
        <Field label="Вопрос" className="col-span-2"><Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={off} aria-label="Вопрос" placeholder="Тип привода" /></Field>
        <Field label="Варианты ответа — по одному в строке" className="col-span-2"><Area rows={4} value={values} onChange={(e) => setValues(e.target.value)} disabled={off} aria-label="Варианты ответа" /></Field>
        <Field label="Откуда ответ"><Select value={kind} onChange={(v) => setKind(v as E3FeatureKind)} disabled={off} aria-label="Откуда ответ" options={(Object.keys(KIND_TITLES) as E3FeatureKind[]).map((k) => ({ value: k, label: KIND_TITLES[k] }))} /></Field>
        <Field label="Если в названии не назван" hint="Пусто — признак обязан быть назван">
          <Select value={absent} onChange={setAbsent} disabled={off} aria-label="Ответ по умолчанию" options={[{ value: '', label: 'признак обязателен' }, ...list.map((v) => ({ value: v, label: v }))]} />
        </Field>
        <Field label="Подсказка" className="col-span-2"><Input value={hint} onChange={(e) => setHint(e.target.value)} disabled={off} aria-label="Подсказка" /></Field>
      </div>
      {problem && <p className="fx-hint mt-3">{problem}</p>}
      {error && <p role="alert" className="fx-error mt-3">{error}</p>}
    </Dialog>
  );
}

export default function E3FeaturesPanel({ state, rights, jump }: { state: SolutionBookState; rights: { edit: boolean }; jump?: JumpProps }) {
  const { book, error, busy, run, setError } = state;
  const addToast = useToastStore((s) => s.addToast);
  const [cls, setCls] = useState('');
  const [editing, setEditing] = useState<string | null>(null); // '' — новый
  const [dialogError, setDialogError] = useState('');
  useJump(jump, ['features'], (j) => { setDialogError(''); setEditing(j.id ?? null); }, !!state.book);
  const features = book?.features || [];
  const classes = useMemo(() => [...new Set([...features.map((f) => f.mainClass), ...(book?.solutions || []).map((s) => s.mainClass)].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru')), [features, book]);
  const shown = features.filter((f) => !cls || f.mainClass === cls);
  const editingFeature = editing ? features.find((f) => f.id === editing) || null : null;
  const rulesOf = (id: string) => (book?.rules || []).filter((r) => r.featureId === id).length;
  const close = () => { setEditing(null); setDialogError(''); };

  const save = async (f: E3Feature) => { if (await run((v) => svc.saveFeature(f, v), setDialogError)) close(); };
  /** Стартовые признаки, правила и правила состава, которых в книге нет: сначала план, потом запись; существующее не меняется */
  const addMissing = async () => {
    try {
      const m = await svc.missingDefaults();
      if (!missingCount(m)) { addToast('Всё стартовое уже есть в каталоге', 'info'); return; }
      const lines = [
        m.features.length && `признаков — ${m.features.length}`, m.rules.length && `правил признаков — ${m.rules.length}`, m.ioRules.length && `правил состава блока — ${m.ioRules.length}`,
        m.classMap.length && `типов в связи с классами — ${m.classMap.length}`, m.filled.length && `решениям будут дописаны ответы на новые признаки — ${m.filled.length}`,
      ].filter(Boolean).join('; ');
      if (!(await confirmAsk('Добавить недостающее?', `Будет добавлено: ${lines}. Что в каталоге уже есть и что правили вручную, не меняется.`, { confirmLabel: 'Добавить' }))) return;
      if (await run((v) => svc.applyMissingDefaults(v))) addToast('Недостающее добавлено в каталог', 'success');
    } catch (e: any) { setError(e.message); }
  };
  const remove = async () => {
    if (!editingFeature) return;
    const n = rulesOf(editingFeature.id);
    if (!(await confirmAsk('Удалить признак?', `«${editingFeature.title}» и ${count(n, 'его правило', 'его правила', 'его правил')} будут убраны из каталога. Ответы в решениях останутся, но подбор их больше не учитывает.`, { confirmLabel: 'Удалить', tone: 'danger' }))) return;
    if (await run((v) => svc.deleteFeature(editingFeature.id, v), setDialogError)) close();
  };

  return (
    <div className="fx-page min-w-0">
      <SectionHead title="Признаки" count={features.length ? count(features.length, 'признак', 'признака', 'признаков') : ''}
        actions={rights.edit && <>
          <Btn tone="ghost" disabled={busy || !book} onClick={() => void addMissing()} title="Дописать стартовые признаки, правила признаков и правила состава блока, которых в каталоге ещё нет">Добавить недостающее</Btn>
          <Btn tone="primary" disabled={busy || !book} onClick={() => { setDialogError(''); setEditing(''); }}><Plus className="w-3.5 h-3.5" /> Добавить признак</Btn>
        </>} />
      {error && editing === null && <p role="alert" className="fx-error px-4 py-1">{error}</p>}
      {!book ? <p className={`p-4 text-sm ${muted}`}>{error ? '' : 'Загружаю каталог…'}</p> : !features.length ? <div className="p-4"><Empty title="Признаков нет" text="Признаки задают, чем отличаются решения одного класса." /></div> : <>
        <Toolbar>
          <Select value={cls} onChange={setCls} aria-label="Основной класс" className="w-auto" options={[{ value: '', label: 'все классы' }, ...classes.map((c) => ({ value: c, label: c }))]} />
        </Toolbar>
        <div className="fx-page-body">
          <table className="fx-table text-left">
            <thead><tr><th>Класс</th><th>Вопрос</th><th>Id</th><th>Варианты</th><th>Откуда ответ</th><th>Правил</th></tr></thead>
            <tbody>{shown.map((f) => (
              <tr key={f.id} tabIndex={0} role="button" className="cursor-pointer" onClick={() => { setDialogError(''); setEditing(f.id); }}
                onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setDialogError(''); setEditing(f.id); } }}>
                <td className="whitespace-nowrap">{f.mainClass}</td>
                <td className="max-w-[260px] truncate" title={f.hint}>{f.title}</td>
                <td className="font-mono">{f.id}</td>
                <td className="max-w-[300px] truncate" title={f.values.join(', ')}>{f.values.join(', ')}</td>
                <td className="whitespace-nowrap">{KIND_TITLES[f.kind]}</td>
                <td className={`tabular-nums ${rulesOf(f.id) ? '' : muted}`}>{rulesOf(f.id) || '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </>}
      {editing !== null && book && (editing === '' || editingFeature) && <FeatureDialog key={`${editing}:${book.version}`} feature={editingFeature} classes={classes} canEdit={rights.edit} busy={busy}
        error={dialogError} onSave={(f) => void save(f)} onDelete={() => void remove()} onClose={close} />}
    </div>
  );
}
