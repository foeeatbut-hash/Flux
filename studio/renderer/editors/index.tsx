/**
 * Редакторы программы в Flux Studio: форма (визуально и текстом), код, договор, правила.
 *
 * Оболочка подключает раздел как `studio-editors` и передаёт файлы проекта по договору
 * studio/shared/editorContract.ts (здесь он повторён в shellContract.ts): <Editors moduleId draft onChange />.
 * Редакторы читают form.json, manifest.json (reads), contract.json (значения договора) и файлы кода,
 * а изменённые файлы отдают в onChange. Пока в тексте form.json ошибка, на диск уходит только верный текст:
 * визуальная вкладка в это время только для чтения, чтобы правка не стёрла набранное.
 */
import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { applyForm, applyText, formStateFromForm, formStateFromText, recheck, type FormState } from './formStore';
import { checkFormDesign } from './designCheck';
import { installEditorStyles } from './styles';
import { sampleData } from './sample';
import { serializeForm } from './formModel';
import { CODE_FALLBACK, codeFiles, contractChanges, contractFromFiles, FORM_FILE } from './packageFiles';
import { tabKeys } from './controls';
import { FormEditor } from './FormEditor';
import { FormTextEditor } from './FormTextEditor';
import { CodeEditor } from './CodeEditor';
import { ContractEditor } from './ContractEditor';
import { RulesPanel } from './RulesPanel';
import type { EditorProps } from '../../shared/editorContract';
import type { CodeFile, ContractDraft, FormDef } from './types';

export { checkFormDesign } from './designCheck';
export { serializeForm } from './formModel';
export { structureProblems, bindingProblems } from './formSchema';
export { generateContractDts, contractReference } from './contractTypes';
export type { EditorProps, EditorDraft } from '../../shared/editorContract';
export type { ModuleDraft, Finding, FormDef, CodeFile, ContractDraft } from './types';

type Tab = 'form' | 'text' | 'code' | 'contract' | 'rules';
const TABS: Array<[Tab, string]> = [['form', 'Форма'], ['text', 'form.json'], ['code', 'Код'], ['contract', 'Договор'], ['rules', 'Правила']];
const TAB_KEYS: Tab[] = TABS.map(([key]) => key);
const HISTORY_LIMIT = 100;
/** Правки текста, сделанные подряд быстрее этого срока, — один шаг отмены */
const TEXT_STEP_MS = 800;

const editable = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName));

export default function Editors({ moduleId, draft, onChange }: EditorProps) {
  const stylesOk = installEditorStyles();
  const files = draft.files;
  const [tab, setTab] = useState<Tab>('form');
  const [saveError, setSaveError] = useState('');
  const [, redraw] = useReducer((n: number) => n + 1, 0);

  // --- Договор: локальная копия, чтобы ввод не ждал ответа оболочки
  const [contract, setContract] = useState<ContractDraft>(() => contractFromFiles(files));
  const pendingContract = useRef<Set<string>>(new Set());
  useEffect(() => {
    const fromFiles = JSON.stringify(contractFromFiles(files));
    if (pendingContract.current.has(fromFiles)) return;
    if (fromFiles !== JSON.stringify(contract)) { pendingContract.current.add(fromFiles); setContract(JSON.parse(fromFiles)); }
  }, [files]);

  // --- Форма: текст и последняя верная форма в одном состоянии
  const [state, setState] = useState<FormState>(() => formStateFromText(files[FORM_FILE] ?? serializeForm({ version: 1, groups: [], tables: [] }), contract));
  // Все тексты, которые мы сами отдали оболочке: её ответ на более раннюю правку не должен откатить набранное позже
  const written = useRef<Set<string>>(new Set(files[FORM_FILE] === undefined ? [] : [files[FORM_FILE]]));
  const lastSaved = useRef<string | undefined>(files[FORM_FILE]);
  const history = useRef<{ past: FormDef[]; future: FormDef[]; textAt: number }>({ past: [], future: [], textAt: 0 });
  const data = useMemo(() => sampleData(), []);

  // Файл изменили снаружи (откат, другой редактор): форма и текст берутся из него, отмена начинается заново
  useEffect(() => {
    const text = files[FORM_FILE];
    if (text === undefined || written.current.has(text) || text === state.text) return;
    written.current.add(text);
    lastSaved.current = text;
    history.current = { past: [], future: [], textAt: 0 };
    setState(formStateFromText(text, contract));
  }, [files[FORM_FILE]]);

  const save = (changed: Record<string, string>) => {
    Promise.resolve(onChange(changed)).then(error => setSaveError(error || ''), error => setSaveError(error instanceof Error ? error.message : String(error)));
  };

  const commit = (next: FormState, source: 'visual' | 'text') => {
    if (next.form !== state.form) {
      const h = history.current;
      const quick = source === 'text' && Date.now() - h.textAt < TEXT_STEP_MS;
      if (!quick) { h.past.push(state.form); if (h.past.length > HISTORY_LIMIT) h.past.shift(); }
      h.textAt = source === 'text' ? Date.now() : 0;
      h.future = [];
    }
    setState(next);
    if (next.textValid && next.text !== lastSaved.current) { lastSaved.current = next.text; written.current.add(next.text); save({ [FORM_FILE]: next.text }); }
    redraw();
  };

  const step = (from: 'past' | 'future', to: 'past' | 'future') => {
    const h = history.current;
    const form = h[from].pop();
    if (!form) return;
    h[to].push(state.form);
    h.textAt = 0;
    const next = formStateFromForm(form, contract);
    setState(next);
    written.current.add(next.text);
    lastSaved.current = next.text;
    save({ [FORM_FILE]: next.text });
    redraw();
  };
  const undo = () => step('past', 'future');
  const redo = () => step('future', 'past');

  const findings = useMemo(() => checkFormDesign(state.form, { contract }), [state.form, contract]);
  const errors = findings.filter(finding => finding.severity === 'error').length + state.bindings.filter(problem => problem.severity === 'error').length;

  // --- Код: тоже локально, по той же причине
  const [codeText, setCodeText] = useState<Record<string, string>>({});
  const writtenCode = useRef<Record<string, Set<string>>>({});
  const remember = (path: string, text: string) => { (writtenCode.current[path] ??= new Set()).add(text); };
  const code: CodeFile[] = useMemo(() => codeFiles(files).map(file => ({ ...file, text: codeText[file.path] ?? file.text })), [files, codeText]);
  useEffect(() => {
    setCodeText(previous => {
      const next = { ...previous };
      for (const file of codeFiles(files)) if (!writtenCode.current[file.path]?.has(file.text) && file.text !== previous[file.path]) { next[file.path] = file.text; remember(file.path, file.text); }
      return next;
    });
  }, [files]);
  const onCode = (changedFiles: CodeFile[]) => {
    const changed: Record<string, string> = {};
    for (const file of changedFiles) {
      const before = code.find(candidate => candidate.path === file.path);
      if (before && before.text !== file.text) changed[file.path] = file.text;
    }
    if (!Object.keys(changed).length) return;
    for (const [path, text] of Object.entries(changed)) remember(path, text);
    setCodeText(previous => ({ ...previous, ...changed }));
    save(changed);
  };

  const onContract = (next: ContractDraft) => {
    setContract(next);
    setState(previous => recheck(previous, next));
    pendingContract.current.add(JSON.stringify(next));
    const { changed, error } = contractChanges(files, next);
    save(changed);
    if (error) setSaveError(error);
  };

  return (
    <div className="ed" data-module={moduleId} data-testid="editors"
      onKeyDown={event => {
        if (tab !== 'form' || !state.textValid || editable(event.target) || !(event.ctrlKey || event.metaKey)) return;
        const key = event.key.toLowerCase();
        if (key === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
        else if (key === 'y') { event.preventDefault(); redo(); }
      }}>
      {!stylesOk && <p className="ed-error" role="alert">Редакторы не запустились: окно не поддерживает нужные стили (constructable stylesheets). Обновите Studio до свежей версии.</p>}
      {saveError && <p className="ed-error ed-save" role="alert" data-testid="save-error">Не сохранено: {saveError}</p>}
      <div className="ed-tabs" role="tablist" aria-label="Редакторы программы" onKeyDown={event => tabKeys<Tab>(event, TAB_KEYS, tab, setTab)}>
        {TABS.map(([key, title]) => (
          <button key={key} type="button" role="tab" className="ed-tab" aria-selected={tab === key} tabIndex={tab === key ? 0 : -1} id={`ed-tab-${key}`} aria-controls={`ed-panel-${key}`} onClick={() => setTab(key)}>
            {title}
            {key === 'text' && !state.textValid && <span className="ed-badge" aria-label="Есть ошибки">{state.problems.length}</span>}
            {key === 'rules' && errors > 0 && <span className="ed-badge" aria-label="Есть ошибки">{errors}</span>}
          </button>
        ))}
      </div>
      {/* Панели остаются смонтированными: у редакторов текста и кода сохраняются отмена и курсор при смене вкладки */}
      <div className="ed-panel" role="tabpanel" id="ed-panel-form" aria-labelledby="ed-tab-form" hidden={tab !== 'form'}>
        <FormEditor state={state} contract={contract} data={data} findings={findings} onForm={form => commit(applyForm(state, form, contract), 'visual')}
          history={{ canUndo: history.current.past.length > 0, canRedo: history.current.future.length > 0, undo, redo }} onGoText={() => setTab('text')} />
      </div>
      <div className="ed-panel" role="tabpanel" id="ed-panel-text" aria-labelledby="ed-tab-text" hidden={tab !== 'text'}>
        <FormTextEditor state={state} onText={text => commit(applyText(state, text, contract), 'text')} />
      </div>
      <div className="ed-panel" role="tabpanel" id="ed-panel-code" aria-labelledby="ed-tab-code" hidden={tab !== 'code'}>
        {code.length ? <CodeEditor files={code} contract={contract} onFiles={onCode} /> : <p className="ed-muted">{CODE_FALLBACK}</p>}
      </div>
      <div className="ed-panel" role="tabpanel" id="ed-panel-contract" aria-labelledby="ed-tab-contract" hidden={tab !== 'contract'}>
        <ContractEditor contract={contract} onChange={onContract} />
      </div>
      <div className="ed-panel" role="tabpanel" id="ed-panel-rules" aria-labelledby="ed-tab-rules" hidden={tab !== 'rules'}>
        <RulesPanel findings={[...state.bindings.map(problem => ({ rule: 'binding', severity: problem.severity, path: '', message: `Строка ${problem.line}: ${problem.message}`, source: 'Договор' })), ...findings]} />
      </div>
    </div>
  );
}
