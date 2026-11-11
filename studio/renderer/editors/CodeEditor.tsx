/**
 * Редактор кода подпрограммы.
 *
 * TypeScript и JavaScript: подсветка, автодополнение и проверка по договору; сам файл типов
 * (contract.d.ts) создаётся из договора и показывается рядом — его же берёт компилятор при
 * выпуске. Остальные языки: подсветка и справка по договору (какой JSON приходит и уходит).
 */
import React, { useMemo, useState } from 'react';
import type { CompletionSource } from '@codemirror/autocomplete';
import { CodeView, type MarkedLine } from './CodeView';
import { checkCode, completeScript, isScript } from './codeSupport';
import { contractReference, generateContractDts } from './contractTypes';
import { SelectField } from './controls';
import type { CodeFile, CodeLanguage, ContractDraft } from './types';

const LANGUAGES: Array<[CodeLanguage, string]> = [
  ['typescript', 'TypeScript'], ['javascript', 'JavaScript'], ['python', 'Python'], ['rust', 'Rust'], ['cpp', 'C++'], ['c', 'C'], ['go', 'Go'], ['csharp', 'C#'],
];
const TYPES_TAB = '__types';

export function CodeEditor({ files, contract, onFiles }: { files: CodeFile[]; contract: ContractDraft; onFiles: (files: CodeFile[]) => void }) {
  const [active, setActive] = useState(files[0]?.path ?? TYPES_TAB);
  const file = files.find(candidate => candidate.path === active);
  const dts = useMemo(() => generateContractDts(contract), [contract]);
  const marks: MarkedLine[] = useMemo(() => file
    ? checkCode(file.language, file.text, contract).map(issue => ({ line: issue.line, column: issue.column, length: issue.length, message: issue.message, severity: issue.severity }))
    : [], [file, contract]);
  const complete: CompletionSource | undefined = useMemo(() => file && isScript(file.language) ? context => {
    const result = completeScript(context.state.doc.sliceString(0, context.pos), contract);
    if (!result) return null;
    return { from: result.from, options: result.options.map(option => ({ label: option.label, detail: option.detail, type: option.kind === 'function' ? 'function' : 'property' })) };
  } : undefined, [file, contract]);

  return (
    <div className="ed-code" data-testid="code-editor">
      <div className="ed-code-main">
        <div className="ed-files" role="tablist" aria-label="Файлы кода">
          {files.map(candidate => (
            <button key={candidate.path} type="button" role="tab" className="ed-btn" aria-selected={active === candidate.path} onClick={() => setActive(candidate.path)}>{candidate.path}</button>
          ))}
          {files.some(candidate => isScript(candidate.language)) && (
            <button type="button" role="tab" className="ed-btn" aria-selected={active === TYPES_TAB} onClick={() => setActive(TYPES_TAB)}>contract.d.ts</button>
          )}
        </div>
        {file ? (
          <CodeView value={file.text} language={file.language} label={`Код: ${file.path}`} marks={marks} complete={complete} testId="code-view"
            onChange={text => onFiles(files.map(candidate => candidate.path === file.path ? { ...candidate, text } : candidate))} />
        ) : (
          <CodeView value={dts} language="typescript" label="Типы из договора, только чтение" readOnly testId="types-view" />
        )}
        {file && (
          <div className="ed-text-foot">
            {marks.length === 0
              ? <p className="ed-ok" role="status" data-testid="code-status">Обращения к данным совпадают с договором.</p>
              : <ul data-testid="code-problems">{marks.map((mark, i) => <li key={i}><span className="ed-line">Строка {mark.line}</span><span className="ed-error">{mark.message}</span></li>)}</ul>}
          </div>
        )}
      </div>
      <aside className="ed-code-side" aria-label="Справка по договору">
        {file && (
          <SelectField label="Язык файла" value={file.language} onChange={language => onFiles(files.map(candidate => candidate.path === file.path ? { ...candidate, language: language as CodeLanguage } : candidate))}>
            {LANGUAGES.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
          </SelectField>
        )}
        <h3 className="ed-title">Справка по договору</h3>
        {file && isScript(file.language)
          ? <p className="ed-hint">Подсказки и проверки идут по типам из договора: см. вкладку contract.d.ts. Пример: <code>flux.read('equipment')</code>.</p>
          : <p className="ed-hint">Для этого языка Flux обменивается JSON: на вход приходит то, что разрешено договором, на выходе ждут state и calc.out.</p>}
        <pre data-testid="contract-reference">{contractReference(contract)}</pre>
      </aside>
    </div>
  );
}
