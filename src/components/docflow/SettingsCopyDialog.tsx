import React from 'react';
import { Dialog, Btn, Select, Status } from '../ui';
import { DOCFLOW_SECTIONS } from '../../../shared/docflow/config';
import { copyPlan, copyApply, listTemplates, type CopySource, type SettingsView, type TemplateView } from '../../lib/docflowApi';
import { dataService, type Project } from '../../services/dataService';

/**
 * «Скопировать из проекта…» и «Создать из шаблона…»: источник → галочки по
 * разделам → предпросмотр различий → применить. Пока предпросмотр не
 * показан, применить нельзя; применение идёт по версии, которую человек
 * видел, и отменяется одним действием (кнопка в настройках).
 */
export default function SettingsCopyDialog({ mode, projectId, current, onClose, onApplied }: {
  mode: 'project' | 'template'; projectId: string; current: SettingsView;
  onClose: () => void; onApplied: (view: SettingsView) => void;
}) {
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [templates, setTemplates] = React.useState<TemplateView[]>([]);
  const [sourceId, setSourceId] = React.useState('');
  const [sections, setSections] = React.useState<string[]>(DOCFLOW_SECTIONS.map((s) => s.key));
  const [plan, setPlan] = React.useState<Awaited<ReturnType<typeof copyPlan>>['data'] | null>(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (mode === 'project') void dataService.getProjects().then((list) => setProjects(list.filter((p) => p.id !== projectId))).catch(() => undefined);
    else void listTemplates().then((a) => a.ok && setTemplates(a.data.templates || []));
  }, [mode, projectId]);
  React.useEffect(() => { setPlan(null); setError(''); }, [sourceId, sections.join(',')]);

  const from: CopySource = mode === 'project' ? { projectId: sourceId } : { templateId: sourceId };
  const preview = async () => {
    setBusy(true); setError('');
    const answer = await copyPlan(projectId, from, sections);
    setBusy(false);
    if (answer.ok) setPlan(answer.data); else setError(answer.data.error || 'Не удалось собрать предпросмотр');
  };
  const apply = async () => {
    setBusy(true); setError('');
    const answer = await copyApply(projectId, from, sections, current.updatedAt);
    setBusy(false);
    if (answer.ok) onApplied(answer.data);
    else setError(answer.status === 409 ? 'Настройки проекта уже изменили — закройте окно и повторите' : answer.data.error || 'Не удалось применить');
  };
  const options = mode === 'project'
    ? projects.map((p) => ({ value: p.id, label: p.name }))
    : templates.map((t) => ({ value: t.id, label: t.name }));
  const changed = plan?.sections.filter((s) => s.lines.length).length ?? 0;

  return (
    <Dialog title={mode === 'project' ? 'Скопировать настройки из проекта' : 'Создать настройки из шаблона'} onClose={onClose} busy={busy} width="max-w-xl"
      footer={<>
        <Btn onClick={onClose} disabled={busy}>Отмена</Btn>
        <Btn onClick={() => void preview()} disabled={busy || !sourceId || !sections.length}>Показать различия</Btn>
        <Btn tone="primary" onClick={() => void apply()} disabled={busy || !plan || !changed}>Применить</Btn>
      </>}>
      <div className="flex flex-col gap-3">
        <label className="fx-field">
          <span className="fx-label">{mode === 'project' ? 'Проект-источник' : 'Шаблон'}</span>
          <Select value={sourceId} onChange={setSourceId} options={[{ value: '', label: 'Выберите…' }, ...options]} aria-label="Источник" />
        </label>
        <fieldset className="flex flex-col gap-1">
          <legend className="fx-label mb-1">Разделы</legend>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            {DOCFLOW_SECTIONS.map((s) => (
              <label key={s.key} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={sections.includes(s.key)} onChange={(e) => setSections((cur) => (e.target.checked ? [...cur, s.key] : cur.filter((k) => k !== s.key)))} />
                {s.label}
              </label>
            ))}
          </div>
        </fieldset>
        {plan && (
          <div aria-label="Предпросмотр различий" className="flex flex-col gap-2">
            <div className="fx-label">Что изменится в проекте{changed ? '' : ' — ничего: отмеченные разделы уже совпадают'}</div>
            {plan.sections.map((s) => (
              <div key={s.key} className="text-xs">
                <div className="font-medium text-slate-700 dark:text-white">{s.label} {s.lines.length ? '' : <span className="text-slate-400">— без изменений</span>}</div>
                {s.lines.slice(0, 12).map((l) => <div key={l} className="pl-3 text-slate-500 dark:text-slate-400">{l}</div>)}
                {s.lines.length > 12 && <div className="pl-3 text-slate-400">…и ещё {s.lines.length - 12}</div>}
              </div>
            ))}
            <div className="fx-hint">Существующие файлы не переименовываются; что разойдётся с новой маской, покажет «Сверка с папкой».</div>
          </div>
        )}
        {error && <Status tone="rose">{error}</Status>}
      </div>
    </Dialog>
  );
}
