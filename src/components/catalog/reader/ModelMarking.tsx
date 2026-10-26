/** Вкладка «Маркировка»: структура кода модели и расшифровка введённого обозначения. */
import React, { useState } from 'react';
import type { Family } from '../../../../catalog/model';
import { textOf } from '../../../../catalog/model';
import { parseWithFamily } from '../../../../catalog/designation';
import CatalogContents from '../CatalogContents';
import { Input } from '../ui';
import { Block, type Report } from './ModelParts';

const muted = 'text-[var(--flux-text-muted)]';
const note = 'border-y border-[var(--flux-line)] px-2 py-3 text-xs';

export default function ModelMarking({ family, onReport }: { family: Family; onReport?: Report }) {
  const [designation, setDesignation] = useState('');
  const text = designation.trim();
  const structured = (family.designationMode || 'structured') === 'structured';
  const parsed = text && structured ? parseWithFamily(family, designation) : undefined;
  return <div className="flex flex-col gap-4">
    <CatalogContents key={`${family.id}-marking`} sections={family.sections || []} kind="marking" />
    <Block title="Расшифровка обозначения">
      <p className={`m-0 text-xs ${muted}`}>Введите код целиком. Расшифровка строится по структуре этой модели; нераспознанный код остаётся без догадок.</p>
    </Block>
    <label className="fx-field"><span className="fx-label">Код изделия</span>
      <Input value={designation} onChange={(e) => setDesignation(e.target.value)} placeholder={family.examples?.[0] || family.code} className="font-mono" /></label>
    {text && family.designationMode === 'article' && <div className={note}>
      {family.article && text.toLocaleLowerCase() === family.article.toLocaleLowerCase()
        ? <span>Артикул совпадает с указанным для модели: <code className="font-mono">{family.article}</code>.</span>
        : <span className={muted}>Для этой модели используется артикул. {family.article ? `В каталоге указан: ${family.article}; введённое значение не совпадает.` : 'Артикул не указан.'} Структурная расшифровка не задана.</span>}
    </div>}
    {text && family.designationMode === 'free' && <div className={`${note} ${muted}`}>Для этой модели каталог не задаёт структурную расшифровку обозначения.</div>}
    {text && parsed && <div className="border-y border-[var(--flux-line)]">
      <div className={`border-b border-[var(--flux-line)] px-2 py-2 text-xs ${parsed.complete ? 'text-[var(--flux-accent-text)]' : 'text-[var(--flux-warn-text,#b45309)]'}`}>{parsed.complete ? 'Код разобран по модели' : 'Полная расшифровка не подтверждена'}</div>
      {Object.entries(parsed.values).map(([key, value]) => {
        const param = family.params.find((p) => p.key === key);
        const choice = param?.values?.find((v) => v.code === String(value));
        return <div key={key} className="grid grid-cols-[minmax(120px,0.6fr)_minmax(0,1fr)_auto] items-center gap-2 border-b border-[var(--flux-line)] px-2 py-2 text-[13px]">
          <span className={muted}>{textOf(param?.label) || key}</span><span className="break-words">{choice ? textOf(choice.label) : `${value}${param?.unit ? ` ${param.unit}` : ''}`}</span>
          {onReport && <button type="button" className="text-xs text-[var(--flux-text-muted)] hover:underline" onClick={() => onReport(key, { currentValue: choice ? textOf(choice.label) : String(value), source: family.catalog })}>Сообщить</button>}
          {choice?.note && <span className={`col-span-2 col-start-2 text-xs ${muted}`}>{choice.note}</span>}
        </div>;
      })}
      {parsed.rest && <div className="px-2 py-2 text-xs text-[var(--flux-warn-text,#b45309)]">Не разобранный остаток: <code className="font-mono">{parsed.rest}</code></div>}
      {!Object.keys(parsed.values).length && <div className={`px-2 py-3 text-xs ${muted}`}>Подходящих частей обозначения не найдено.</div>}
    </div>}
    {!text && <div className={`${note} ${muted}`}>Введите обозначение, чтобы увидеть найденные параметры.</div>}
    {structured && family.positions.length > 0 && <Block title="Структура кода">
      <div className="flex flex-wrap gap-x-3 gap-y-1">{family.positions.map((p, i) => <span key={p.key} className={`text-xs ${muted}`}><span className="text-[var(--flux-text)]">{textOf(p.label)}</span>{i < family.positions.length - 1 ? ' · ' : ''}</span>)}</div>
    </Block>}
  </div>;
}
