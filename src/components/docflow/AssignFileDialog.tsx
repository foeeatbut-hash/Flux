import React from 'react';
import { Btn, Dialog, Field, Input, Select } from '../ui';
import NameCheckView from './NameCheckView';
import ImportFileChooser from '../ImportFileChooser';
import RowPicker, { cipherOfRow, type PickRow } from './RowPicker';
import type { ProjectDocs } from './useProjectDocs';
import { createLink, planLink, type LinkPlan } from '../../lib/docflowApi';
import { bindingsOfProject, executePlacement, planPlacement, readSource, refindSource, type FileSource } from '../../lib/docflowAssign';
import { newGroup } from '../../lib/docflowFiles';
import type { ProjectFolderBinding } from '../../lib/projectFolderBindings';
import { windowsFilesRequest, type WindowsFileRef } from '../../lib/windowsFiles';
import { parseFileName } from '../../../shared/docflow/nameMask';
import type { LinkRole } from '../../../shared/docflow/links';

/**
 * «Назначить файл…» и «Назначить возврат…» (docs/docflow-program.md, 4.1, 7.3).
 * Один диалог для ДО (строка известна, файл выбирают по пути) и для Проводника
 * (файл известен, строку выбирают). Сервер проверяет имя ещё раз сам: здесь
 * человек видит расхождения и предложение переименовать до того, как что-либо
 * будет перемещено.
 */
export interface AssignFileDialogProps {
  role: LinkRole;
  projectId: string;
  docs: ProjectDocs;
  bindings: ProjectFolderBinding[];
  row?: PickRow;
  file?: WindowsFileRef;
  /** Предлагать ли «Переименовать в …» (ДО). Из Проводника имя исправляет сам человек (F2): окно только показывает расхождения. */
  renameOffer?: boolean;
  onClose: () => void;
  onDone: () => void;
}

// Дата получения — календарный день на часах пользователя, а не по UTC
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export default function AssignFileDialog({ role, projectId, docs, bindings, row: fixedRow, file, renameOffer = true, onClose, onDone }: AssignFileDialogProps) {
  const { config } = docs;
  const mine = React.useMemo(() => bindingsOfProject(bindings, projectId), [bindings, projectId]);
  const [row, setRow] = React.useState<PickRow | null>(fixedRow || null);
  const [source, setSource] = React.useState<FileSource | null>(null);
  const [path, setPath] = React.useState('');
  const [plan, setPlan] = React.useState<LinkPlan | null>(null);
  const [fix, setFix] = React.useState<'rename' | 'self'>('rename');
  const [replace, setReplace] = React.useState(false);
  const [toLinkId, setToLinkId] = React.useState('');
  const [reviewCode, setReviewCode] = React.useState('');
  const [received, setReceived] = React.useState(today());
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [note, setNote] = React.useState('');

  const open = React.useCallback(async (ref: WindowsFileRef) => {
    setBusy(true); setError(''); setNote('');
    const read = await readSource(ref, mine);
    setBusy(false);
    if (!read) { setError('Не удалось прочитать файл. Проверьте путь и доступ.'); return; }
    setSource(read);
  }, [mine]);
  React.useEffect(() => { if (file) void open(file); }, [file, open]);

  const byPath = async () => {
    const answer = await windowsFilesRequest<WindowsFileRef | null>({ action: 'resolveAddress', text: path.trim() });
    if (!answer.ok || !answer.data) { setError('Файл по этому пути не найден среди доступных папок. Нажмите «Выбрать…».'); return; }
    await open(answer.data);
  };

  // Проверка имени и строка для сборки имени и подпапки — у сервера, он же решает окончательно
  React.useEffect(() => {
    if (!row || !source) { setPlan(null); return; }
    let alive = true;
    void planLink(row.id, role === 'file' ? source.name : '').then((a) => { if (alive) { if (a.ok) setPlan(a.data); else setError(a.data.error || 'Не удалось проверить имя'); } });
    return () => { alive = false; };
  }, [row?.id, source?.name, role]);

  // Возврат бывает только к выданной ревизии; по умолчанию — последняя выданная
  const fileLinks = React.useMemo(() => {
    const issued = docs.issues.filter((i) => row && i.itemId === row.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return issued.map((i) => docs.links.find((l) => l.id === i.linkId && l.role === 'file' && !l.unlinkedAt)).filter((l): l is NonNullable<typeof l> => !!l);
  }, [docs.links, docs.issues, row?.id]);
  React.useEffect(() => { setToLinkId(fileLinks[0]?.id || ''); }, [fileLinks]);
  const rule = config.reviewCodes.find((c) => c.code === reviewCode);
  const nextStatus = rule && rule.action !== 'info' ? config.statuses.find((s) => s.code === (rule.status || (rule.action === 'accept' ? 'ACCEPTED' : 'REMARKS')))?.label || '' : '';

  const blocked = role === 'file' && !!plan?.blocked;
  const finalName = source ? (blocked && fix === 'rename' && plan?.expectedName ? plan.expectedName : source.name) : '';
  const revision = role === 'remarks' ? fileLinks.find((l) => l.id === toLinkId)?.revision || '' : plan?.check.revision || row?.revision || '';
  const placement = source && plan ? planPlacement({ source, role, config, row: plan.row, revision, projectId, bindings: mine, finalName }) : null;
  const needReplace = role === 'file' && !!plan?.sameRevisionFile;
  const ready = !!source && !!row && !!plan && !!placement && !placement.error && !busy && (!blocked || (renameOffer && fix === 'rename' && !!plan.expectedName)) && (!needReplace || replace) && (role === 'file' || (!!toLinkId && !!received));
  const hint = React.useMemo(() => (source ? parseFileName(config, source.name).fields['шифр'] : undefined), [config, source?.name]);

  const recheck = async () => {
    if (!source) return;
    setBusy(true); setError('');
    const ref = await refindSource(source);
    setBusy(false);
    if (!ref) { setError('Файл не найден на прежнем месте. Выберите его заново.'); return; }
    await open(ref);
  };

  const submit = async () => {
    if (!ready || !source || !row || !plan || !placement) return;
    setBusy(true); setError(''); setNote('');
    try {
      const result = await executePlacement(placement, source, role, newGroup(role === 'file' ? 'file' : 'remarks'));
      const answer = await createLink({
        itemId: row.id, role, ...(role === 'remarks' ? { toLinkId, reviewCode, receivedAt: received } : {}), folderKey: result.folderKey, relativePath: result.relativePath,
        fileName: result.finalName, sha256: result.sha256, size: result.size, replace,
        ...(role === 'remarks' ? { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } : {}),
      });
      if (!answer.ok) {
        setError(`${result.moved ? 'Файл уже перенесён (отменить можно в Проводнике, Ctrl+Z), но связать не удалось: ' : 'Связать не удалось: '}${answer.data.error || 'ошибка сервера'}`);
        setBusy(false);
        return;
      }
      // Код рассмотрения, следующий статус и срок ответа записывает сервер вместе со связью
      onDone(); onClose();
    } catch (e: any) { setError(e?.message || 'Не удалось выполнить назначение'); setBusy(false); }
  };

  const title = role === 'file' ? 'Назначить файл' : 'Назначить возврат';
  return (
    <Dialog title={title} onClose={() => !busy && onClose()} width="max-w-2xl" busy={busy}
      footer={<><Btn disabled={busy} onClick={onClose}>Отмена</Btn><Btn tone="primary" disabled={!ready} onClick={() => void submit()}>{placement && !placement.inPlace ? 'Переместить и назначить' : 'Назначить'}</Btn></>}>
      <div className="space-y-4 text-xs">
        {!file && (
          <Field label="Файл" hint="Путь к файлу или выбор в окне Windows. Файл может лежать где угодно, например в «Загрузках».">
            <div className="flex gap-2">
              <Input aria-label="Путь к файлу" value={path} placeholder="C:\Users\…\Загрузки\Замечания.pdf" onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && path.trim()) void byPath(); }} />
              <Btn disabled={!path.trim() || busy} onClick={() => void byPath()}>Найти</Btn>
              <ImportFileChooser label="Выбрать…" disabled={busy} onFiles={() => undefined} onWindowsFile={(ref) => void open(ref)} />
            </div>
          </Field>
        )}
        {source && <p data-assign-file><strong className="font-medium">{source.name}</strong> · {source.size.toLocaleString('ru-RU')} Б · {source.placed ? `в папке проекта «${source.placed.binding.label}»` : 'вне папок проекта'}</p>}

        {fixedRow ? <p>Строка: <strong className="font-medium">{cipherOfRow(config, fixedRow) || '—'}</strong> · {fixedRow.titleRu || fixedRow.titleEn} · {fixedRow.vdrCode} · ред. {fixedRow.revision}</p>
          : source && <Field label="Строка реестра"><RowPicker projectId={projectId} config={config} cipherHint={hint} selectedId={row?.id} onPick={setRow} /></Field>}

        {role === 'file' && plan && row && (
          <div className="space-y-2 rounded border border-slate-200 p-3 dark:border-slate-700">
            <NameCheckView check={plan.check} />
            {blocked && !renameOffer && <p className="text-rose-700 dark:text-rose-400">Переименуйте файл (F2) так, чтобы имя сходилось со строкой, и свяжите снова.</p>}
            {blocked && renameOffer && (
              <div role="radiogroup" aria-label="Что сделать с именем" className="space-y-1.5 pt-1">
                {plan.expectedName
                  ? <label className="flex items-start gap-2"><input type="radio" name="fix" checked={fix === 'rename'} onChange={() => setFix('rename')} /><span>Переименовать в <strong className="font-medium">{plan.expectedName}</strong><br /><span className="text-slate-500 dark:text-slate-400">{source?.name} → {plan.expectedName}</span></span></label>
                  : <p className="text-amber-700 dark:text-amber-400">По строке имя собрать нельзя: у строки не хватает полей для маски «{config.masks.file}».</p>}
                <label className="flex items-start gap-2"><input type="radio" name="fix" checked={fix === 'self'} onChange={() => setFix('self')} /><span>Исправлю сам: переименую файл и нажму «Проверить снова»</span></label>
                {fix === 'self' && <Btn size="sm" disabled={busy} onClick={() => void recheck()}>Проверить снова</Btn>}
              </div>
            )}
            {needReplace && <label className="flex items-start gap-2 pt-1"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /><span>У строки уже есть файл ревизии {plan.sameRevisionFile!.revision}: «{plan.sameRevisionFile!.fileName}». Заменить его этим (прежний уйдёт в историю).</span></label>}
          </div>
        )}

        {role === 'remarks' && row && source && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="К файлу ревизии"><Select value={toLinkId} onChange={setToLinkId} options={fileLinks.length ? fileLinks.map((l) => ({ value: l.id, label: `ред. ${l.revision} · ${l.fileName}` })) : [{ value: '', label: 'Нет выданной ревизии', disabled: true }]} /></Field>
            <Field label="Код рассмотрения"><Select value={reviewCode} onChange={setReviewCode} options={[{ value: '', label: 'Не указан' }, ...config.reviewCodes.map((c) => ({ value: c.code, label: `${c.code} — ${c.label}` }))]} /></Field>
            <Field label="Получен"><Input type="date" value={received} onChange={(e) => setReceived(e.target.value)} /></Field>
            {reviewCode && <p data-return-effect className="text-slate-600 sm:col-span-3 dark:text-slate-300">{nextStatus ? `Статус строки станет «${nextStatus}». ` : 'Статус строки не изменится. '}{rule && rule.deadlineDays > 0 && received ? `Срок ответа — ${rule.deadlineDays} календарных дн. от даты получения.` : ''}</p>}
          </div>
        )}

        {placement && source && (
          <p data-assign-plan className={placement.error ? 'text-rose-700 dark:text-rose-400' : 'text-slate-600 dark:text-slate-300'}>
            {placement.error || (placement.inPlace
              ? `Файл остаётся на месте${placement.rename ? ` и переименовывается в «${placement.finalName}»` : ''}.`
              : `Файл будет перемещён в «${placement.binding?.label}»${placement.folderPath ? ` / ${placement.folderPath}` : ''}${placement.rename ? ` и переименован в «${placement.finalName}»` : ''}. Отменить можно в Проводнике (Ctrl+Z).`)}
          </p>
        )}
        {note && <p role="status">{note}</p>}
        {error && <p role="alert" className="text-rose-600 dark:text-rose-400">{error}</p>}
      </div>
    </Dialog>
  );
}
