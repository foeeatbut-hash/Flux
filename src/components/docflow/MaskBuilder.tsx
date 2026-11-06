import React from 'react';
import type { DocflowConfig } from '../../../shared/docflow/config';
import { MASK_FIELDS, isIgnored, maskErrors, parseFileName } from '../../../shared/docflow/nameMask';
import { Field, Input, Select, Area, Status, Btn } from '../ui';
import { useStore } from '../../store/store';
import { useBindingLedger } from '../explorer/useProjectFolderBindings';
import { bindingFor, scanFolder } from '../../lib/docflowAssign';
import { folderOfBinding } from '../../lib/docflowFiles';

/**
 * Конструктор маски имени файла и шифра (docs/docflow-program.md, раздел 5).
 *
 * Поля вставляются нажатием, разделители пишутся руками; ниже — примеры имён и
 * то, как каждое из них разберётся этой маской, ещё до сохранения. Имена из
 * рабочей папки читаются отдельно: проверка не меняет файлы и связи реестра.
 */
export default function MaskBuilder({ projectId, config, onChange, disabled, samples, onSamples }: {
  projectId: string;
  config: DocflowConfig; onChange: (next: DocflowConfig) => void; disabled?: boolean;
  samples: string; onSamples: (text: string) => void;
}) {
  const [target, setTarget] = React.useState<'file' | 'cipher'>('file');
  const userId = useStore((s) => s.user?.id);
  const { bindings } = useBindingLedger(userId);
  const work = bindingFor(bindings, projectId, 'work');
  const workKey = JSON.stringify([projectId, work?.locationKey, work?.locator]);
  const request = React.useRef(0);
  const [folder, setFolder] = React.useState<{ key: string; files: Array<{ relativePath: string; name: string }>; truncated: boolean } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  React.useEffect(() => {
    request.current++;
    setFolder(null); setBusy(false); setError('');
    return () => { request.current++; };
  }, [workKey]);
  const checkFolder = async () => {
    if (!work) return;
    const id = ++request.current;
    setFolder(null); setBusy(true); setError('');
    try {
      const root = await folderOfBinding(work);
      if (!root) throw new Error(`Папка «${work.label}» не найдена на этом компьютере. Откройте её в Проводнике и привяжите заново.`);
      const scan = await scanFolder(root);
      // За время обхода человек мог сменить проект или назначение папки.
      if (request.current === id) setFolder({ key: workKey, ...scan });
    } catch (e: unknown) {
      if (request.current === id) setError(e instanceof Error ? e.message : 'Не удалось прочитать рабочую папку');
    } finally { if (request.current === id) setBusy(false); }
  };
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
  const files = folder?.key === workKey ? folder.files : null;
  const table = (items: Array<{ path: string; name: string }>, label: string) => (
    <div className="overflow-x-auto">
      <table className="fx-table" aria-label={label}>
        <thead><tr><th>Имя</th>{columns.map((c) => <th key={c.key}>{c.label}</th>)}<th>Итог</th></tr></thead>
        <tbody>{items.map(({ path, name }) => {
          const ignored = isIgnored(config, name);
          const p = parseFileName(config, name);
          return <tr key={path}>
            <td className="code" title={path}>{path}</td>
            {columns.map((c) => <td key={c.key} className="code">{!ignored && p.fields[c.key] || <span className="text-slate-400 dark:text-slate-500">—</span>}</td>)}
            <td>{ignored ? <Status tone="slate">Не документ</Status> : p.ok && !p.problems.length ? <Status tone="emerald">читается</Status>
              : <Status tone={p.ok ? 'amber' : 'rose'} title={p.problems.join('; ')}>{p.problems.join('; ')}</Status>}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  );

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
      {names.length > 0 && table(names.map((name, i) => ({ path: `${i + 1}. ${name}`, name })), 'Разбор примеров')}
      <div className="flex flex-wrap items-center gap-2">
        <Btn disabled={busy || !work} onClick={() => void checkFolder()}>Проверить на файлах рабочей папки</Btn>
        <span className="fx-hint">{busy ? 'Читаю папку…' : work ? `Рабочая папка: ${work.label}, включая подпапки` : 'Назначьте рабочую папку проекта в Проводнике: «Привязать к проекту» → «Рабочая».'}</span>
      </div>
      {error && <p role="alert" className="fx-error">{error}</p>}
      {files && <>
        <p className="fx-hint">Прочитано файлов: {files.length}{folder?.truncated ? ' · обход остановлен на 5000 файлах, проверена только часть папки' : ''}. Файлы и связи не изменены.</p>
        {files.length ? table(files.map((f) => ({ path: f.relativePath, name: f.name })), 'Разбор файлов рабочей папки') : <p className="fx-hint">В рабочей папке нет файлов.</p>}
      </>}
    </div>
  );
}
