import React from 'react';
import type { DocflowConfig } from '../../../shared/docflow/config';
import { MASK_FIELDS, maskErrors, parseFileName } from '../../../shared/docflow/nameMask';
import { Field, Input, Select, Area, Status } from '../ui';

/**
 * Конструктор маски имени файла и шифра (docs/docflow-program.md, раздел 5).
 *
 * Поля вставляются нажатием, разделители пишутся руками; ниже — примеры имён и
 * то, как каждое из них разберётся этой маской, ещё до сохранения. Проверка
 * на файлах папки проекта — те же примеры: их можно вставить списком.
 */
export default function MaskBuilder({ config, onChange, disabled, samples, onSamples }: {
  config: DocflowConfig; onChange: (next: DocflowConfig) => void; disabled?: boolean;
  samples: string; onSamples: (text: string) => void;
}) {
  const [target, setTarget] = React.useState<'file' | 'cipher'>('file');
  const fileRef = React.useRef<HTMLInputElement>(null);
  const cipherRef = React.useRef<HTMLInputElement>(null);
  const setMask = (key: 'file' | 'cipher', value: string) => onChange({ ...config, masks: { ...config.masks, [key]: value } });
  const insert = (field: string) => {
    const el = (target === 'file' ? fileRef : cipherRef).current;
    const cur = config.masks[target];
    const at = el?.selectionStart ?? cur.length;
    const next = `${cur.slice(0, at)}{${field}}${cur.slice(el?.selectionEnd ?? at)}`;
    setMask(target, next);
    requestAnimationFrame(() => { el?.focus(); const p = at + field.length + 2; el?.setSelectionRange(p, p); });
  };
  const fileErrors = maskErrors(config.masks.file);
  const cipherErrors = config.masks.cipher.trim() ? maskErrors(config.masks.cipher, 'cipher') : [];
  const names = samples.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 50);
  const columns = MASK_FIELDS.filter((f) => `${config.masks.file}${config.masks.cipher}`.includes(`{${f.key}}`) || f.key === 'шифр');

  return (
    <div className="flex flex-col gap-3">
      <Field label="Маска имени файла (без расширения)" hint="Например {шифр}_{ред}: «3700-B01-E02-001_B.pdf»">
        <Input ref={fileRef} value={config.masks.file} disabled={disabled} onFocus={() => setTarget('file')} onChange={(e) => setMask('file', e.target.value)} className="font-mono" aria-invalid={fileErrors.length > 0} />
      </Field>
      {fileErrors.map((e) => <div key={e} className="fx-error">{e}</div>)}
      <Field label="Маска шифра" hint="Как поле {шифр} делится на части; пусто — шифр читается целиком">
        <Input ref={cipherRef} value={config.masks.cipher} disabled={disabled} onFocus={() => setTarget('cipher')} onChange={(e) => setMask('cipher', e.target.value)} className="font-mono" aria-invalid={cipherErrors.length > 0} />
      </Field>
      {cipherErrors.map((e) => <div key={e} className="fx-error">{e}</div>)}
      <div className="flex flex-wrap items-center gap-1" aria-label="Поля маски">
        <span className="fx-label mr-1">Вставить в {target === 'file' ? 'имя' : 'шифр'}:</span>
        {MASK_FIELDS.filter((f) => target === 'file' || (f.key !== 'шифр' && f.key !== 'ред')).map((f) => (
          <button key={f.key} type="button" disabled={disabled} title={f.hint} onClick={() => insert(f.key)} className="fx-btn fx-btn-sm fx-btn-quiet font-mono">{`{${f.key}}`}</button>
        ))}
      </div>
      <Field label="С каким шифром строки ВДР сравнивать">
        <Select value={config.masks.cipherSource} disabled={disabled} onChange={(v) => onChange({ ...config, masks: { ...config.masks, cipherSource: v as any } })}
          options={[{ value: 'contractorNo', label: 'Шифр подрядчика' }, { value: 'ownerNo', label: 'Шифр заказчика' }, { value: 'vendorNo', label: 'Шифр поставщика' }]} />
      </Field>
      <Field label="Не документ (служебные файлы)" hint="Через запятую: *.bak, ~$*">
        <Input value={config.masks.ignore.join(', ')} disabled={disabled} onChange={(e) => onChange({ ...config, masks: { ...config.masks, ignore: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } })} />
      </Field>
      <Field label="Примеры имён — по одному в строке" hint="Вставьте имена файлов из папки проекта: видно, как они разберутся, до сохранения">
        <Area rows={3} value={samples} onChange={(e) => onSamples(e.target.value)} className="font-mono" placeholder="3700-B01-E02-001_B.pdf" />
      </Field>
      {names.length > 0 && (
        <table className="fx-table" aria-label="Разбор примеров">
          <thead><tr><th>Имя</th>{columns.map((c) => <th key={c.key}>{c.label}</th>)}<th>Итог</th></tr></thead>
          <tbody>
            {names.map((name) => {
              const p = parseFileName(config, name);
              return (
                <tr key={name}>
                  <td className="code">{name}</td>
                  {columns.map((c) => <td key={c.key} className="code">{p.fields[c.key] || <span className="text-slate-400">—</span>}</td>)}
                  <td>{p.ok && !p.problems.length ? <Status tone="emerald">читается</Status>
                    : <Status tone={p.ok ? 'amber' : 'rose'} title={p.problems.join('; ')}>{p.problems.join('; ')}</Status>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
