/**
 * Вкладка «Правила оформления»: замечания проверки формы и выписка из методологии.
 * Тексты правил приходят из docs/methodology/01-design.md при сборке (methodology.generated.ts).
 */
import React from 'react';
import { RULES } from './methodology';
import type { Finding } from './types';

export function RulesPanel({ findings }: { findings: Finding[] }) {
  return (
    <div className="ed-rules" data-testid="rules">
      <section aria-label="Замечания к форме">
        <h3 className="ed-title">Замечания к форме</h3>
        {findings.length === 0
          ? <p className="ed-ok" role="status" data-testid="rules-status">Замечаний по оформлению нет.</p>
          : (
            <ul className="ed-findings" data-testid="rules-findings">
              {findings.map((finding, i) => (
                <li key={i} className={`is-${finding.severity}`}>
                  {finding.message}
                  <span className="ed-src">{finding.path || 'форма'} · {finding.source}</span>
                </li>
              ))}
            </ul>
          )}
      </section>
      <section aria-label="Правила текста">
        <h3 className="ed-title">Правила текста интерфейса</h3>
        <ul>{RULES.text.map((rule, i) => <li key={i}>{rule}</li>)}</ul>
      </section>
      <section aria-label="Проверка перед готово">
        <h3 className="ed-title">Проверка перед «готово»</h3>
        <p className="ed-hint">Часть пунктов проверяется здесь автоматически, остальное — по снимку.</p>
        <ul>{RULES.checklist.map((rule, i) => <li key={i}>{rule}</li>)}</ul>
        <p className="ed-hint">{RULES.source}</p>
      </section>
    </div>
  );
}
