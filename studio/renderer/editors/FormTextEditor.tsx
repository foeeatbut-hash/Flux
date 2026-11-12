/**
 * Текстовый редактор form.json. Показывает тот же файл, что собирает визуальный редактор:
 * правка здесь сразу меняет форму, а ошибка (с номером строки) форму не трогает.
 */
import React, { useMemo, useState } from 'react';
import { CodeView, type MarkedLine } from './CodeView';
import type { FormState } from './formStore';

export function FormTextEditor({ state, onText }: { state: FormState; onText: (text: string) => void }) {
  const [reveal, setReveal] = useState<{ line: number; nonce: number } | null>(null);
  const all = useMemo(() => [...state.problems, ...state.bindings], [state.problems, state.bindings]);
  const marks: MarkedLine[] = useMemo(() => all.map(problem => ({ line: problem.line, column: problem.column, message: problem.message, severity: problem.severity })), [all]);

  return (
    <div className="ed-text" data-testid="form-text">
      <CodeView value={state.text} onChange={onText} language="json" label="Текст form.json" marks={marks} reveal={reveal} testId="form-json" />
      <div className="ed-text-foot" aria-label="Ошибки текста">
        {state.textValid ? (
          all.length === 0
            ? <p className="ed-ok" role="status" data-testid="text-status">Форма верна: правки видны в визуальном редакторе сразу.</p>
            : <p className="ed-muted" role="status" data-testid="text-status">Текст принят, но источники значений нужно поправить: {all.length}.</p>
        ) : (
          <p className="ed-error" role="status" data-testid="text-status">
            Текст не принят: в визуальном редакторе осталась последняя верная форма. Исправьте ошибки ниже.
          </p>
        )}
        {all.length > 0 && (
          <ul data-testid="text-problems">
            {all.map((problem, i) => (
              <li key={i}>
                <button type="button" className="ed-btn ed-line" onClick={() => setReveal({ line: problem.line, nonce: Date.now() + i })}>Строка {problem.line}</button>
                <span className={problem.severity === 'error' ? 'ed-error' : 'ed-muted'}>{problem.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
