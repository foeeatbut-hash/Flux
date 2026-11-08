import React from 'react';
import { AlertTriangle, FileText, Lock, LockOpen } from 'lucide-react';
import ContextMenu, { type MenuItem } from '../ContextMenu';
import { LOCK_VIOLATION_TEXT, type DocLinkDto, type IssueDto } from '../../../shared/docflow/links';
import type { ProjectFolderBinding } from '../../lib/projectFolderBindings';
import { openLinked } from '../../lib/docflowFiles';
import { lockLink, unlinkLink } from '../../lib/docflowApi';
import { useToastStore } from '../../store/toastStore';
import CreateFilesDialog from '../docflow/CreateFilesDialog';

/**
 * Столбцы «Файл» и «Возврат» строки Реестра — всё ссылками (docs/docflow-program.md, 7.4).
 * Щелчок открывает файл, правая кнопка — «Показать в Проводнике», «Назначить другой…», «Отвязать».
 * Пусто — кнопка «Назначить…» (только при праве docflow.files). Файл не найден — красная ссылка с причиной.
 */
export interface FileCellProps {
  projectId: string;
  itemId: string;
  revision?: string;
  /** Связи строки: действующие, отсортированные по ревизии (последняя последней). */
  links: DocLinkDto[];
  role: 'file' | 'remarks';
  bindings: ProjectFolderBinding[];
  canAssign: boolean;
  /** Выпуск файла этой ревизии: по нему видно «изменён после выпуска». */
  issue?: IssueDto | null;
  /** Срок ответа на возврат (ISO) — просроченный выделяется. */
  dueDate?: string | null;
  onAssign: () => void;
  onChanged: () => void;
}

export default function FileCell({ projectId, itemId, revision, links, role, bindings, canAssign, issue, dueDate, onAssign, onChanged }: FileCellProps) {
  const toast = useToastStore((s) => s.addToast);
  const [menu, setMenu] = React.useState<{ x: number; y: number } | null>(null);
  const [creating, setCreating] = React.useState(false);
  const mine = links.filter((l) => l.role === role && (role !== 'file' || !revision || l.revision === revision));
  // Файл — текущая (последняя) ревизия; возврат — последний по выданной ревизии
  // Возвраты последней выданной ревизии: столбец показывает первый из них и «+N» об остальных
  const lastRevision = role === 'remarks' ? mine[mine.length - 1]?.revision : undefined;
  const group = role === 'remarks' ? mine.filter((l) => l.revision === lastRevision) : [];
  const main = role === 'remarks' ? group[0] : mine[mine.length - 1];
  const extra = role === 'remarks' ? group.length - 1 : 0;
  const problem = main?.lostAt ? 'файл удалён или перемещён' : main?.mismatch?.length ? `имя не совпадает со строкой: ${main.mismatch.join('; ')}` : '';
  const open = async (how: 'open' | 'reveal') => { if (!main) return; const why = await openLinked(main, bindings, how); if (why) toast(why, 'error'); };
  const items: MenuItem[] = main ? [
    { label: 'Открыть', onClick: () => void open('open') },
    { label: 'Показать в Проводнике', onClick: () => void open('reveal') },
    { label: 'Назначить другой…', separated: true, disabled: !canAssign, onClick: onAssign },
    ...(role === 'file' ? [{ label: 'Создать или открыть файл…', disabled: !canAssign, onClick: () => setCreating(true) }] : []),
    { label: 'Отвязать', danger: true, disabled: !canAssign, onClick: () => { void unlinkLink(itemId, main.id, 'отвязан в реестре').then((a) => { if (a.ok) { toast('Файл отвязан; связь осталась в истории', 'success'); onChanged(); } else toast(a.data.error || 'Не удалось отвязать', 'error'); }); } },
  ] : [];
  return (
    <>
      {main ? <button type="button" data-file-link={role} title={problem ? `${main.fileName} — ${problem}` : main.fileName}
        onClick={(e) => { e.stopPropagation(); void open('open'); }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY }); }}
        className={`inline-flex max-w-44 items-center gap-1 text-left underline decoration-dotted ${problem ? 'text-rose-600 dark:text-rose-400' : 'text-sky-700 dark:text-sky-300'}`}>
        {problem ? <AlertTriangle size={13} aria-hidden /> : <FileText size={13} aria-hidden />}
        <span className="truncate">{role === 'file' ? `ред. ${main.revision}` : main.fileName}</span>
        {extra > 0 && <span className="shrink-0 text-slate-500">+{extra}</span>}
      </button> : canAssign && (role === 'file' || links.some(l => l.role === 'file')) ? <span className="inline-flex gap-2">
        <button type="button" data-assign={role} onClick={e => { e.stopPropagation(); onAssign(); }} className="text-sky-700 underline decoration-dotted dark:text-sky-300">Назначить…</button>
        {role === 'file' && <button type="button" data-create-docflow-file onClick={e => { e.stopPropagation(); setCreating(true); }} className="text-sky-700 underline decoration-dotted dark:text-sky-300">Создать…</button>}
      </span> : <span className="text-slate-400">—</span>}
      {main && (() => {
        const violation = main.locked && main.lockViolation ? LOCK_VIOLATION_TEXT[main.lockViolation] : '';
        const who = [main.locked ? (main.lockedAt ? `Заблокирован ${new Date(main.lockedAt).toLocaleString('ru-RU')}${main.lockedByName ? `, ${main.lockedByName}` : ''}` : 'Заблокирован') : `Замок снят ${main.unlockedAt ? new Date(main.unlockedAt).toLocaleString('ru-RU') : ''}${main.unlockedByName ? `, ${main.unlockedByName}` : ''}`.trim()];
        const action = canAssign ? (main.locked ? 'Нажмите, чтобы снять замок и разрешить правку' : 'Нажмите, чтобы заблокировать файл') : 'Менять замок может сотрудник с правом «Назначение файлов и возвратов»';
        const text = `${violation ? `Нарушена блокировка: файл ${violation}. ` : ''}${who}. ${action}.`;
        return <button type="button" data-file-lock={main.locked ? 'locked' : 'open'} data-lock-violation={violation ? main.lockViolation : undefined} aria-label={text} aria-pressed={main.locked} title={text} disabled={!canAssign}
          onClick={(e) => { e.stopPropagation(); void lockLink(itemId, main.id, !main.locked).then((a) => { if (a.ok) { toast(main.locked ? 'Замок снят: файл можно править' : 'Файл заблокирован', 'success'); onChanged(); } else toast(a.data.error || 'Не удалось изменить замок', 'error'); }); }}
          className={`ml-1 inline-flex align-middle ${violation ? 'text-rose-600 dark:text-rose-400' : main.locked ? 'text-slate-600 dark:text-slate-300' : 'text-amber-600 dark:text-amber-400'} ${canAssign ? 'cursor-pointer' : 'cursor-default opacity-70'}`}>
          {main.locked ? <Lock size={13} aria-hidden /> : <LockOpen size={13} aria-hidden />}
        </button>;
      })()}
      {main?.locked && main.lockViolation && <span data-lock-violation-text className="ml-1 text-xs font-semibold text-rose-600 dark:text-rose-400">{LOCK_VIOLATION_TEXT[main.lockViolation]}</span>}
      {role === 'file' && main && issue?.changed && <span data-changed-after-issue className="ml-1 text-xs text-amber-700 dark:text-amber-400" title="Отпечаток файла не совпадает с отпечатком при выпуске">изменён после выпуска ред. {issue.revision}</span>}
      {role === 'file' && main && issue && !issue.changed && <span data-issued className="ml-1 text-xs text-slate-500" title={`Выпущена ${issue.date}`}>выдан</span>}
      {role === 'remarks' && main && dueDate && <span data-return-due className={`ml-1 text-xs ${new Date(dueDate).getTime() < Date.now() ? 'font-semibold text-rose-600 dark:text-rose-400' : 'text-slate-500'}`} title="Срок ответа на возврат — от даты получения">до {new Date(dueDate).toLocaleDateString('ru-RU')}{new Date(dueDate).getTime() < Date.now() ? ' · просрочено' : ''}</span>}
      {menu && main && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
      {creating && canAssign && role === 'file' && <CreateFilesDialog projectId={projectId} itemIds={[itemId]} onClose={() => setCreating(false)} onDone={onChanged} />}
    </>
  );
}
