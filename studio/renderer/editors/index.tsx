/**
 * Редакторы подпрограммы в Flux Studio: форма (визуально и текстом), код, договор, правила.
 *
 * Оболочка подключает раздел лениво и передаёт черновик: <Editors moduleId draft onChange />.
 * Черновик меняется только верной формой: пока в тексте form.json ошибка, наружу уходит
 * последняя верная форма.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { applyForm, applyText, formStateFromForm, recheck, type FormState } from './formStore';
import { checkFormDesign } from './designCheck';
import { installEditorStyles } from './styles';
import { sampleData } from './sample';
import { FormEditor } from './FormEditor';
import { FormTextEditor } from './FormTextEditor';
import { CodeEditor } from './CodeEditor';
import { ContractEditor } from './ContractEditor';
import { RulesPanel } from './RulesPanel';
import type { ContractDraft, EditorProps, FormDef } from './types';

export { checkFormDesign } from './designCheck';
export { serializeForm } from './formModel';
export { structureProblems, bindingProblems } from './formSchema';
export { generateContractDts, contractReference } from './contractTypes';
export type { ModuleDraft, EditorProps, Finding, FormDef, CodeFile, ContractDraft } from './types';

type Tab = 'form' | 'text' | 'code' | 'contract' | 'rules';
const TABS: Array<[Tab, string]> = [['form', 'Форма'], ['text', 'form.json'], ['code', 'Код'], ['contract', 'Договор'], ['rules', 'Правила']];

export default function Editors({ moduleId, draft, onChange, previewData }: EditorProps & { previewData?: Record<string, unknown> }) {
  installEditorStyles();
  const [tab, setTab] = useState<Tab>('form');
  const [state, setState] = useState<FormState>(() => formStateFromForm(draft.form, draft.contract));
  const data = useMemo(() => previewData ?? sampleData(), [previewData]);
  const sent = useRef<FormDef>(draft.form);

  // Черновик заменили снаружи (другой модуль, откат): форма и текст берутся из него.
  // Своё же эхо узнаём по содержимому, чтобы не затирать текст, который сейчас набирают.
  useEffect(() => {
    if (draft.form === sent.current) return;
    sent.current = draft.form;
    setState(previous => JSON.stringify(previous.form) === JSON.stringify(draft.form) ? recheck(previous, draft.contract) : formStateFromForm(draft.form, draft.contract));
  }, [draft.form, draft.contract]);

  const push = (next: FormState, contract: ContractDraft = draft.contract) => {
    setState(next);
    if (next.form !== state.form) { sent.current = next.form; onChange({ ...draft, form: next.form, contract }); }
  };
  const findings = useMemo(() => checkFormDesign(state.form, { contract: draft.contract }), [state.form, draft.contract]);
  const errors = findings.filter(finding => finding.severity === 'error').length + state.bindings.filter(problem => problem.severity === 'error').length;

  return (
    <div className="ed" data-module={moduleId} data-testid="editors">
      <div className="ed-tabs" role="tablist" aria-label="Редакторы подпрограммы">
        {TABS.map(([key, title]) => (
          <button key={key} type="button" role="tab" className="ed-tab" aria-selected={tab === key} id={`ed-tab-${key}`} aria-controls={`ed-panel-${key}`} onClick={() => setTab(key)}>
            {title}
            {key === 'text' && !state.textValid && <span className="ed-badge" aria-label="Есть ошибки">{state.problems.length}</span>}
            {key === 'rules' && errors > 0 && <span className="ed-badge" aria-label="Есть ошибки">{errors}</span>}
          </button>
        ))}
      </div>
      <div className="ed-panel" role="tabpanel" id={`ed-panel-${tab}`} aria-labelledby={`ed-tab-${tab}`}>
        {tab === 'form' && <FormEditor state={state} contract={draft.contract} data={data} findings={findings} onForm={form => push(applyForm(state, form, draft.contract))} />}
        {tab === 'text' && <FormTextEditor state={state} onText={text => push(applyText(state, text, draft.contract))} />}
        {tab === 'code' && <CodeEditor files={draft.code} contract={draft.contract} onFiles={code => onChange({ ...draft, code })} />}
        {tab === 'contract' && <ContractEditor contract={draft.contract} onChange={contract => { const next = recheck(state, contract); setState(next); onChange({ ...draft, contract }); }} />}
        {tab === 'rules' && <RulesPanel findings={[...state.bindings.map(problem => ({ rule: 'binding', severity: problem.severity, path: '', message: `Строка ${problem.line}: ${problem.message}`, source: 'Договор' })), ...findings]} />}
      </div>
    </div>
  );
}
