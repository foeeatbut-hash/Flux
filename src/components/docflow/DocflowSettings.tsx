import React from 'react';
import { Toolbar, Btn, Field, Input, Status, Empty } from '../ui';
import { useModalStore } from '../../store/modalStore';
import type { DocflowConfig, DocflowStatus, DocflowReason, DocflowReviewCode, DocflowDocType, DocflowDeadline } from '../../../shared/docflow/config';
import { DOCFLOW_SECTIONS } from '../../../shared/docflow/config';
import { folderPath, rowFields, maskErrors } from '../../../shared/docflow/nameMask';
import { getSettings, putSettings, undoSettings, saveTemplate, type SettingsView } from '../../lib/docflowApi';
import RowsEditor from './RowsEditor';
import EquipmentClassesEditor from './EquipmentClassesEditor';
import EquipmentClassActions from './EquipmentClassActions';
import { useAppContext } from '../../store/policyStore';
import { can } from '../../lib/permissions';
import { classMappingErrors } from '../../../shared/docflow/classMapping';
import MaskBuilder from './MaskBuilder';
import SettingsCopyDialog from './SettingsCopyDialog';
import StandardsMigrationDialog from './StandardsMigrationDialog';

const { openPrompt } = useModalStore.getState();

// ── Документооборот → «Настройки»: настройки ДО выбранного проекта ──
// Раньше здесь правились глобальные стандарты для всех проектов сразу. Теперь
// у проекта своя копия (docs/docflow-program.md, раздел 5): её можно
// скопировать из другого проекта или шаблона с предпросмотром и отменой, а
// правка одного проекта не меняет другие.

const TONES = [
  { value: 'slate', label: 'серый' }, { value: 'violet', label: 'фиолетовый' }, { value: 'emerald', label: 'зелёный' },
  { value: 'sky', label: 'синий' }, { value: 'amber', label: 'жёлтый' }, { value: 'rose', label: 'красный' },
];
const sourceText = (v: SettingsView | null) => {
  if (!v?.source) return '';
  const s = v.source;
  if (!v.stored) return s.kind === 'standard' ? `Пока не сохранены — показаны из стандарта «${s.name}»` : 'Пока не сохранены — показаны по умолчанию';
  if (s.kind === 'project') return `Скопировано из проекта «${s.name}», ${s.at}`;
  if (s.kind === 'template') return `Создано из шаблона «${s.name}», ${s.at}`;
  if (s.kind === 'standard') return `Перенесено из стандарта «${s.name}»${s.at ? `, ${s.at}` : ''}`;
  return '';
};

export default function DocflowSettings({ projectId, canEdit, isAdmin, addToast }: {
  projectId: string; canEdit: boolean; isAdmin: boolean; addToast: (text: string, kind?: any) => void;
}) {
  const { user } = useAppContext();
  const [view, setView] = React.useState<SettingsView | null>(null);
  const [draft, setDraft] = React.useState<DocflowConfig | null>(null);
  const [section, setSection] = React.useState('statuses');
  const [busy, setBusy] = React.useState(false);
  const [dialog, setDialog] = React.useState<'' | 'project' | 'template' | 'migration'>('');
  const [samples, setSamples] = React.useState('3700-B01-E02-001_B.pdf\n3700-B01-E2-001.pdf');
  const [error, setError] = React.useState('');

  const accept = (v: SettingsView) => { setView(v); setDraft(JSON.parse(JSON.stringify(v.config))); };
  const load = React.useCallback(async () => {
    const answer = await getSettings(projectId);
    if (answer.ok) { accept(answer.data); setError(''); } else setError(answer.data.error || 'Не удалось прочитать настройки');
  }, [projectId]);
  React.useEffect(() => { setView(null); setDraft(null); void load(); }, [load]);

  const dirty = !!view && !!draft && JSON.stringify(view.config) !== JSON.stringify(draft);
  const save = async () => {
    if (!draft || !view) return;
    const mappingErrors = classMappingErrors(draft.equipmentClasses);
    if (mappingErrors.length) { addToast(mappingErrors[0], 'error'); setSection('equipmentClasses'); return; }
    setBusy(true);
    const answer = await putSettings(projectId, draft, view.updatedAt);
    setBusy(false);
    if (answer.ok) { accept(answer.data); addToast('Настройки проекта сохранены', 'success'); return; }
    if (answer.status === 409 && answer.data.current) {
      accept(answer.data.current);
      addToast('Настройки уже изменил другой человек — показаны текущие. Повторите правку.', 'error');
      return;
    }
    addToast(answer.data.error || 'Не удалось сохранить', 'error');
  };
  const undo = async () => {
    setBusy(true);
    const answer = await undoSettings(projectId);
    setBusy(false);
    if (answer.ok) { accept(answer.data); addToast('Перенос отменён', 'success'); } else addToast(answer.data.error || 'Отменить нельзя', 'error');
  };
  const asTemplate = async () => {
    if (dirty) { addToast('Сначала сохраните настройки проекта', 'error'); return; }
    const name = await openPrompt('Сохранить как шаблон', 'Шаблон — снимок настроек; проекты копируют его, а не ссылаются.', 'Например: Заказчик «Азот»', '');
    if (!name) return;
    const answer = await saveTemplate(projectId, name);
    if (answer.ok) addToast(`Шаблон «${answer.data.template.name}» сохранён`, 'success'); else addToast(answer.data.error || 'Не удалось сохранить шаблон', 'error');
  };

  if (error) return <div className="p-4"><Status tone="rose">{error}</Status></div>;
  if (!draft || !view) return <div className="p-4 text-sm text-slate-400">Загрузка…</div>;
  const ro = !canEdit;
  const set = <K extends keyof DocflowConfig>(key: K, value: DocflowConfig[K]) => setDraft((d) => (d ? { ...d, [key]: value } : d));
  const sample = { contractorNo: '3700-B01-E02-001', vdrCode: 'E02', revision: 'B', language: 'RU', tags: ['П-1'] };
  const maskBad = maskErrors(draft.masks.file).length > 0;
  const mappingBad = classMappingErrors(draft.equipmentClasses).length > 0;

  return (
    <div className="flex h-full min-h-0">
      <nav className="fx-side w-52 shrink-0 overflow-y-auto py-1" aria-label="Разделы настроек">
        {DOCFLOW_SECTIONS.map((s) => (
          <button key={s.key} type="button" className="fx-li w-full text-left" aria-current={section === s.key ? 'true' : undefined} onClick={() => setSection(s.key)}>{s.label}</button>
        ))}
      </nav>
      <div className="flex-1 min-w-0 flex flex-col">
        <Toolbar>
          <span className="text-xs text-slate-500 dark:text-dark-text-muted truncate min-w-0" title={sourceText(view)}>{sourceText(view)}</span>
          <div className="flex-1" />
          {canEdit && <Btn tone="ghost" onClick={() => setDialog('project')} disabled={busy || dirty}>Скопировать из проекта…</Btn>}
          {canEdit && <Btn tone="ghost" onClick={() => setDialog('template')} disabled={busy || dirty}>Из шаблона…</Btn>}
          {canEdit && <Btn tone="ghost" onClick={() => void asTemplate()} disabled={busy}>Сохранить как шаблон</Btn>}
          {canEdit && view.canUndo && <Btn tone="ghost" onClick={() => void undo()} disabled={busy || dirty} title={view.undoLabel}>Отменить {view.undoLabel || 'перенос'}</Btn>}
          {isAdmin && <Btn tone="ghost" onClick={() => setDialog('migration')} disabled={busy}>Стандарты → проекты…</Btn>}
          {canEdit && <Btn tone="primary" onClick={() => void save()} disabled={busy || !dirty || maskBad || mappingBad}>{busy ? 'Сохраняю…' : 'Сохранить'}</Btn>}
        </Toolbar>
        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          <div className="max-w-4xl flex flex-col gap-3">
            {ro && <Status tone="slate">Только просмотр: настройки правит сотрудник с правом «Настройки документооборота».</Status>}
            {section === 'statuses' && <RowsEditor<DocflowStatus> label="Статусы" rows={draft.statuses} disabled={ro} addLabel="статус" onChange={(v) => set('statuses', v)}
              blank={{ code: '', label: '', tone: 'slate', issue: false }}
              columns={[{ key: 'code', title: 'Код', width: '110px', mono: true }, { key: 'label', title: 'Название' }, { key: 'tone', title: 'Точка', width: '130px', kind: 'select', options: TONES }, { key: 'issue', title: 'Можно выпускать', width: '120px', kind: 'check' }]} />}
            {section === 'revisions' && <>
              <RowsEditor<DocflowReason> label="Причины выпуска" rows={draft.reasons} disabled={ro} addLabel="причина" onChange={(v) => set('reasons', v)}
                blank={{ code: '', label: '', revKind: 'letter' }}
                columns={[{ key: 'code', title: 'Код', width: '90px', mono: true }, { key: 'label', title: 'Название' }, { key: 'revKind', title: 'Ревизии', width: '140px', kind: 'select', options: [{ value: 'letter', label: 'A, B, C…' }, { value: 'digit', label: '0, 1, 2…' }] }]} />
              <div className="grid grid-cols-2 gap-3 max-w-md">
                <Field label="Ревизия «аннулирован»"><Input value={draft.specialRevisions.void} disabled={ro} className="font-mono" onChange={(e) => set('specialRevisions', { ...draft.specialRevisions, void: e.target.value })} /></Field>
                <Field label="Ревизия «заменён»"><Input value={draft.specialRevisions.superseded} disabled={ro} className="font-mono" onChange={(e) => set('specialRevisions', { ...draft.specialRevisions, superseded: e.target.value })} /></Field>
              </div>
            </>}
            {section === 'reviewCodes' && <RowsEditor<DocflowReviewCode> label="Коды рассмотрения" rows={draft.reviewCodes} disabled={ro} addLabel="код" onChange={(v) => set('reviewCodes', v)}
              blank={{ code: '', label: '', action: 'revise', deadlineDays: 10 }}
              columns={[{ key: 'code', title: 'Код', width: '70px', mono: true }, { key: 'label', title: 'Название' },
                { key: 'action', title: 'Действие', width: '130px', kind: 'select', options: [{ value: 'accept', label: 'принят' }, { value: 'revise', label: 'замечания' }, { value: 'info', label: 'для сведения' }] },
                { key: 'status', title: 'Следующий статус', width: '150px', kind: 'select', options: [{ value: '', label: 'по действию' }, ...draft.statuses.map((s) => ({ value: s.code, label: s.label }))] },
                { key: 'deadlineDays', title: 'Срок, дн.', width: '90px', kind: 'number' }]} />}
            {section === 'types' && <RowsEditor<DocflowDocType> label="Типы документов" rows={draft.vdrTypes} disabled={ro} addLabel="тип" onChange={(v) => set('vdrTypes', v)}
              blank={{ code: '', titleRu: '', titleEn: '', stage: '', template: '' }}
              columns={[{ key: 'code', title: 'Код ВДР', width: '90px', mono: true, placeholder: 'E02' }, { key: 'titleRu', title: 'Наименование' }, { key: 'titleEn', title: 'English' },
                { key: 'stage', title: 'Стадия', width: '80px', kind: 'select', options: [{ value: '', label: '—' }, { value: 'П', label: 'П' }, { value: 'Р', label: 'Р' }] },
                { key: 'template', title: 'Шаблон файла', placeholder: 'путь к шаблону' }]} />}
            {section === 'masks' && <MaskBuilder key={projectId} projectId={projectId} config={draft} onChange={setDraft} disabled={ro} samples={samples} onSamples={setSamples} />}
            {section === 'folders' && <div className="flex flex-col gap-3 max-w-xl">
              <p className="text-xs text-slate-500 dark:text-slate-400">Сами папки привязываются в Проводнике («Привязать папку» → назначение). Здесь — структура внутри каждой.</p>
              {([['work', 'Рабочая'], ['issue', 'Выпуск'], ['returns', 'Возвраты'], ['incoming', 'Входящие']] as const).map(([key, label]) => (
                <Field key={key} label={label} hint={`Пример: ${folderPath(draft.folders[key], rowFields(draft, sample, 'B')) || 'в корне папки'}`}>
                  <Input value={draft.folders[key]} disabled={ro} className="font-mono" placeholder="{тип}/{шифр}" onChange={(e) => set('folders', { ...draft.folders, [key]: e.target.value })} />
                </Field>
              ))}
            </div>}
            {mappingBad && section !== 'equipmentClasses' && <Status tone="rose">Исправьте соответствия классов оборудования перед сохранением.</Status>}
            {section === 'equipmentClasses' && <div className="space-y-4"><EquipmentClassesEditor rows={draft.equipmentClasses} disabled={ro} onChange={(v) => set('equipmentClasses', v)} />
              {can(user, 'equipment.manage') && <><p className="fx-note">Сохраните соответствия перед заполнением. Существующие теги меняются только после предпросмотра.</p>
                <EquipmentClassActions projectId={projectId} disabled={dirty || busy} /></>}
            </div>}
            {section === 'kits' && <Empty title={`Комплектов: ${draft.kits.length}`} text="Комплекты документов по классам оборудования настраиваются на следующем этапе; уже заданные переносятся между проектами вместе с остальными разделами." />}
            {section === 'deadlines' && <RowsEditor<DocflowDeadline> label="Сроки по типам документов" rows={draft.deadlines.byType} disabled={ro} addLabel="срок" onChange={(v) => set('deadlines', { ...draft.deadlines, byType: v })}
              blank={{ type: '', from: 'Старт', days: 10, workdays: true }}
              columns={[{ key: 'type', title: 'Тип', width: '90px', mono: true }, { key: 'from', title: 'От вехи' }, { key: 'days', title: 'Дней', width: '80px', kind: 'number' }, { key: 'workdays', title: 'Рабочих', width: '90px', kind: 'check' }]} />}
            {section === 'signers' && <div className="grid grid-cols-2 gap-3 max-w-xl">
              {([['developed', 'Разработал'], ['checked', 'Проверил'], ['approved', 'Утвердил'], ['normControl', 'Нормоконтроль']] as const).map(([key, label]) => (
                <Field key={key} label={label}><Input value={draft.signers[key]} disabled={ro} onChange={(e) => set('signers', { ...draft.signers, [key]: e.target.value })} /></Field>
              ))}
            </div>}
            {section === 'columns' && <RowsEditor<{ key: string; title: string }> label="Колонки ВДР" rows={draft.columns} disabled={ro} addLabel="колонка" onChange={(v) => set('columns', v)}
              blank={{ key: '', title: '' }} columns={[{ key: 'key', title: 'Поле', width: '200px', mono: true }, { key: 'title', title: 'Заголовок у заказчика' }]} />}
          </div>
        </div>
      </div>
      {(dialog === 'project' || dialog === 'template') && <SettingsCopyDialog mode={dialog} projectId={projectId} current={view} onClose={() => setDialog('')}
        onApplied={(v) => { accept(v); setDialog(''); addToast('Настройки перенесены. Отменить можно кнопкой «Отменить перенос».', 'success'); }} />}
      {dialog === 'migration' && <StandardsMigrationDialog onClose={() => setDialog('')} onDone={() => void load()} />}
    </div>
  );
}
