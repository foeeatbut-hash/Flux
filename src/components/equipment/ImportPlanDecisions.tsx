import CustomSelect from '../CustomSelect';

/**
 * Решения плана импорта, которые не про теги: спорная установка, переехавшая
 * или заменённая позиция, позиции проекта, которых нет в XML. Каждое — строка:
 * слева что и почему, справа компактный выбор. Пока спорное не решено,
 * подтвердить импорт нельзя — это проверяет окно импорта.
 */
type Choices = Record<string, string>;

function DecisionRow({ text, hint, value, options, placeholder, disabled, onChange }: {
  text: string; hint?: string; value: string; options: Array<{ value: string; label: string }>; placeholder?: string; disabled: boolean; onChange: (value: string) => void;
}) {
  return <li className="flex min-w-0 items-center gap-3 border-b border-[var(--flux-line)] py-1 last:border-b-0">
    <div className="min-w-0 flex-1 text-xs" title={hint ? `${text} — ${hint}` : text}>
      <div className="truncate">{text}</div>
      {hint && <div className="line-clamp-2 text-[var(--flux-text-muted)]">{hint}</div>}
    </div>
    <div className="w-44 shrink-0 @2xl:w-56"><CustomSelect ariaLabel={text} disabled={disabled} value={value} placeholder={placeholder} options={options} onChange={onChange} menuAlign="right" menuClassName="min-w-64" /></div>
  </li>;
}

export default function ImportPlanDecisions({ plan, choices, onChoice, disabled }: {
  plan: any; choices: Choices; onChoice: (key: string, value: string) => void; disabled: boolean;
}) {
  const systemRows: any[] = plan?.systemRows || [];
  const matches: any[] = plan?.matches || [];
  const missing: any[] = plan?.missing || [];
  const open = [...systemRows, ...matches].filter(row => !choices[row.key]).length;
  return <>
    {(systemRows.length > 0 || matches.length > 0) && <section className="@container rounded border border-amber-300 bg-amber-50 px-3 py-1.5 dark:border-amber-900 dark:bg-amber-950/30" aria-label="Нужно решение">
      <h4 className="py-1 text-xs font-medium text-amber-950 dark:text-amber-200">Нужно решение · не решено: {open}</h4>
      <ul>
        {systemRows.map(row => <DecisionRow key={row.key} text={row.why || `Выберите установку для ${row.name}`} value={choices[row.key] || ''} placeholder="Требуется выбор" disabled={disabled}
          options={(row.options || []).map((o: any) => ({ value: o.value, label: o.label }))} onChange={value => onChoice(row.key, value)} />)}
        {matches.map(row => <DecisionRow key={row.key} text={`${row.title} · ${row.at}`} hint={row.why} value={choices[row.key] || ''} placeholder="Требуется выбор" disabled={disabled}
          options={(row.options || []).map((o: any) => ({ value: o.value, label: o.label }))} onChange={value => onChoice(row.key, value)} />)}
      </ul>
    </section>}
    {missing.length > 0 && <section className="@container rounded border border-[var(--flux-line)] px-3 py-1.5" aria-label="Позиции, которых нет в XML">
      <h4 className="py-1 text-xs font-medium">Позиции проекта, которых нет в XML ({missing.length})<span className="ml-2 font-normal text-[var(--flux-text-muted)]">По умолчанию остаются без изменений; снятие — только явным выбором.</span></h4>
      <ul>
        {missing.map(item => <DecisionRow key={item.key} text={`${item.title || item.name || item.label || item.id} · ${item.at || item.systemName || ''}`} value={choices[item.key] || 'keep'} disabled={disabled}
          options={[{ value: 'keep', label: 'Оставить' }, { value: 'remove', label: 'Снять эту позицию' }]} onChange={value => onChoice(item.key, value)} />)}
      </ul>
    </section>}
  </>;
}
