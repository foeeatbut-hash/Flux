import React from 'react';
import { Btn, Dialog, Field, Input, Select } from '../ui';
import type { ProjectDocs } from './useProjectDocs';
import { createLink } from '../../lib/docflowApi';
import { describeFile } from '../../lib/docflowFiles';
import type { WindowsFileRef } from '../../lib/windowsFiles';
import type { DocEntryInfo } from '../files/docEntryInfo';

/**
 * «Добавить в реестр…» (docs/docflow-program.md, 3.3): новая строка ВДР, поля
 * заполнены из имени файла по маске проекта; наименование и теги вводит человек.
 * Имя не по маске — сначала исправить: строка с шифром, которого нет в имени, не создаётся.
 */
interface RegisterOption { id: string; name: string }

export default function AddToRegistryDialog({ projectId, docs, file, info, onClose, onDone }: { projectId: string; docs: ProjectDocs; file: WindowsFileRef; info: DocEntryInfo; onClose: () => void; onDone: () => void }) {
  const { config } = docs;
  const fields = info.parsed?.fields || {};
  const cipher = fields['шифр'] ?? '';
  const type = fields['тип'] ?? '';
  const revision = (fields['ред'] ?? '').toUpperCase();
  const problems = info.offMask.length ? info.offMask : !cipher ? ['в имени нет шифра'] : !type ? ['в имени нет типа документа'] : [];
  const [registers, setRegisters] = React.useState<RegisterOption[]>([]);
  const [registerId, setRegisterId] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [tags, setTags] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    let alive = true;
    void fetch(`/api/vdr/registers?projectId=${encodeURIComponent(projectId)}`).then((r) => (r.ok ? r.json() : null)).then((body) => {
      if (!alive || !body) return;
      const list: RegisterOption[] = (body.registers || []).map((r: any) => ({ id: r.id, name: r.name }));
      setRegisters(list); setRegisterId((current) => current || list[0]?.id || '');
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [projectId]);

  const typeTitle = config.vdrTypes.find((t) => t.code.toUpperCase() === type.toUpperCase())?.titleRu || '';
  const ready = !problems.length && !!registerId && !!title.trim() && !busy;

  const submit = async () => {
    setBusy(true); setError('');
    try {
      const digest = await describeFile(file);
      const codes = tags.split(/[;,]/).map((t) => t.trim()).filter(Boolean);
      const made = await fetch('/api/vdr/items', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ registerId, [config.masks.cipherSource]: cipher, vdrCode: type, revision, titleRu: title.trim(), ...(fields['язык'] ? { language: fields['язык'] } : {}), equipmentTags: JSON.stringify(codes) }),
      });
      const created = await made.json().catch(() => ({}));
      if (!made.ok) throw new Error(created.error || 'Не удалось создать строку');
      const linked = await createLink({ itemId: created.item.id, role: 'file', folderKey: info.folderKey, relativePath: info.relativePath, fileName: file.relativePath.split('/').pop() || '', sha256: digest?.sha256, size: digest?.size });
      if (!linked.ok) throw new Error(`Строка создана, но файл не связан: ${linked.data.error || 'ошибка сервера'}. Свяжите его через «Связать со строкой ВДР…».`);
      onDone(); onClose();
    } catch (e: any) { setError(e?.message || 'Не удалось добавить в реестр'); setBusy(false); }
  };

  return (
    <Dialog title="Добавить в реестр" onClose={() => !busy && onClose()} busy={busy}
      footer={<><Btn disabled={busy} onClick={onClose}>Отмена</Btn><Btn tone="primary" disabled={!ready} onClick={() => void submit()}>Добавить</Btn></>}>
      <div className="space-y-3 text-xs">
        {problems.length > 0
          ? <p role="alert" className="text-rose-700 dark:text-rose-400">Имя файла не по маске проекта: {problems.join('; ')}. Исправьте имя (F2) и добавьте снова.</p>
          : <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1"><dt className="text-slate-500 dark:text-slate-400">Шифр</dt><dd>{cipher}</dd><dt className="text-slate-500 dark:text-slate-400">Тип</dt><dd>{type}{typeTitle ? ` · ${typeTitle}` : ''}</dd><dt className="text-slate-500 dark:text-slate-400">Ревизия</dt><dd>{revision || '—'}</dd></dl>}
        <Field label="Реестр"><Select value={registerId} onChange={setRegisterId} options={registers.length ? registers.map((r) => ({ value: r.id, label: r.name })) : [{ value: '', label: 'В проекте нет реестра', disabled: true }]} /></Field>
        <Field label="Наименование"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например, Общий вид установки" /></Field>
        <Field label="Теги оборудования" hint="Через запятую; можно оставить пустым."><Input value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
        {error && <p role="alert" className="text-rose-600 dark:text-rose-400">{error}</p>}
      </div>
    </Dialog>
  );
}
