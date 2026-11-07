import React from 'react';
import { AlertTriangle, FileText } from 'lucide-react';
import ContextMenu, { type MenuItem } from '../ContextMenu';
import type { DocLinkDto } from '../../../shared/docflow/links';
import type { ProjectFolderBinding } from '../../lib/projectFolderBindings';
import { openLinked } from '../../lib/docflowFiles';
import { unlinkLink } from '../../lib/docflowApi';
import { useToastStore } from '../../store/toastStore';

/**
 * Столбцы «Файл» и «Возврат» строки Реестра — всё ссылками (docs/docflow-program.md, 7.4).
 * Щелчок открывает файл, правая кнопка — «Показать в Проводнике», «Назначить другой…», «Отвязать».
 * Пусто — кнопка «Назначить…» (только при праве docflow.files). Файл не найден — красная ссылка с причиной.
 */
export interface FileCellProps {
  itemId: string;
  /** Связи строки: действующие, отсортированные по ревизии (последняя последней). */
  links: DocLinkDto[];
  role: 'file' | 'remarks';
  bindings: ProjectFolderBinding[];
  canAssign: boolean;
  onAssign: () => void;
  onChanged: () => void;
}

export default function FileCell({ itemId, links, role, bindings, canAssign, onAssign, onChanged }: FileCellProps) {
  const toast = useToastStore((s) => s.addToast);
  const [menu, setMenu] = React.useState<{ x: number; y: number } | null>(null);
  const mine = links.filter((l) => l.role === role);
  // Файл — текущая (последняя) ревизия; возврат — последний по выданной ревизии
  const main = mine[mine.length - 1];
  const extra = role === 'remarks' ? mine.filter((l) => l.revision === main?.revision).length - 1 : 0;
  if (!main) {
    if (role === 'remarks' && !links.some((l) => l.role === 'file')) return <span className="text-slate-400">—</span>;
    return canAssign ? <button type="button" data-assign={role} onClick={(e) => { e.stopPropagation(); onAssign(); }} className="text-sky-700 underline decoration-dotted dark:text-sky-300">Назначить…</button> : <span className="text-slate-400">—</span>;
  }
  const problem = main.lostAt ? 'файл удалён или перемещён' : main.mismatch?.length ? `имя не совпадает со строкой: ${main.mismatch.join('; ')}` : '';
  const open = async (how: 'open' | 'reveal') => { const why = await openLinked(main, bindings, how); if (why) toast(why, 'error'); };
  const items: MenuItem[] = [
    { label: 'Открыть', onClick: () => void open('open') },
    { label: 'Показать в Проводнике', onClick: () => void open('reveal') },
    { label: 'Назначить другой…', separated: true, disabled: !canAssign, onClick: onAssign },
    { label: 'Отвязать', danger: true, disabled: !canAssign, onClick: () => { void unlinkLink(itemId, main.id, 'отвязан в реестре').then((a) => { if (a.ok) { toast('Файл отвязан; связь осталась в истории', 'success'); onChanged(); } else toast(a.data.error || 'Не удалось отвязать', 'error'); }); } },
  ];
  return (
    <>
      <button type="button" data-file-link={role} title={problem ? `${main.fileName} — ${problem}` : main.fileName}
        onClick={(e) => { e.stopPropagation(); void open('open'); }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY }); }}
        className={`inline-flex max-w-44 items-center gap-1 text-left underline decoration-dotted ${problem ? 'text-rose-600 dark:text-rose-400' : 'text-sky-700 dark:text-sky-300'}`}>
        {problem ? <AlertTriangle size={13} aria-hidden /> : <FileText size={13} aria-hidden />}
        <span className="truncate">{role === 'file' ? `ред. ${main.revision}` : main.fileName}</span>
        {extra > 0 && <span className="shrink-0 text-slate-500">+{extra}</span>}
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </>
  );
}
