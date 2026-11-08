import React from 'react';
import type { DocLinkDto } from '../../../shared/docflow/links';
import { getItemLinks, planLink } from '../../lib/docflowApi';
import { renameFile, newGroup } from '../../lib/docflowFiles';
import type { WindowsFileRef } from '../../lib/windowsFiles';
import type { ProjectDocs } from '../docflow/useProjectDocs';
import { Btn } from '../ui';
import { StatusDot } from './DocColumns';
import type { DocEntryInfo } from './docEntryInfo';
import { X as T } from './explorerTheme';

/**
 * Блок «Документооборот» в «Сведениях» файла (docs/docflow-program.md, 3.2):
 * строка ВДР, ревизия этого файла и последняя ревизия документа, статус,
 * ответственный, срок, история файлов по ревизиям, файлы замечаний.
 */
export default function DocDetails({ info, docs, fileRef, onOpen, onUnlink, onChanged, canFiles }: {
  info: DocEntryInfo; docs: ProjectDocs; fileRef: WindowsFileRef; onOpen: () => void; onUnlink: () => void; onChanged: () => void; canFiles: boolean;
}) {
  const item = info.item;
  const [history, setHistory] = React.useState<DocLinkDto[]>([]);
  const [fix, setFix] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const itemId = item?.id;
  const mismatch = info.link?.mismatch;
  React.useEffect(() => {
    let alive = true;
    setHistory([]);
    if (itemId) void getItemLinks(itemId).then((a) => { if (alive && a.ok) setHistory(a.data.links); });
    return () => { alive = false; };
  }, [itemId, info.link?.id, docs.links.length]);
  React.useEffect(() => {
    let alive = true;
    setFix('');
    if (itemId && mismatch?.length) void planLink(itemId, info.link!.fileName).then((a) => { if (alive && a.ok) setFix(a.data.expectedName); });
    return () => { alive = false; };
  }, [itemId, mismatch?.join('|'), info.link?.fileName]);

  const rename = async () => {
    setBusy(true);
    try { await renameFile(fileRef, fix, newGroup('rename')); onChanged(); } finally { setBusy(false); }
  };
  const revisions = [...new Set(history.filter((l) => l.role === 'file').map((l) => l.revision))].sort();
  return (
    <section aria-label="Документооборот" data-doc-details className={`mt-5 border-t pt-4 ${T.line}`}>
      <h3 className="mb-2 text-xs font-semibold">Документооборот</h3>
      {!item ? (
        <div className="space-y-1 text-xs">
          <p className={T.muted}>{info.role === 'remarks' ? 'Файл в папке возвратов не назначен ни к одной строке.' : 'Нет в реестре.'}</p>
          {info.offMask.length > 0 && <p className="text-amber-700 dark:text-amber-400">Имя не по маске проекта: {info.offMask.join('; ')}.</p>}
        </div>
      ) : (
        <dl className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-2 text-xs">
          <dt className={T.muted}>Шифр</dt><dd className="break-words">{item.cipher || '—'}</dd>
          <dt className={T.muted}>Наименование</dt><dd className="break-words">{item.title || '—'}</dd>
          <dt className={T.muted}>Тип</dt><dd>{item.vdrCode || '—'}</dd>
          <dt className={T.muted}>Теги</dt><dd className="break-words">{item.tags.join(', ') || '—'}</dd>
          <dt className={T.muted}>{info.role === 'remarks' ? 'К ревизии' : 'Этот файл'}</dt><dd>ред. {(info.role === 'remarks' ? info.remarksTo?.revision : info.link?.revision) || '—'}{item.revision && item.revision !== info.link?.revision ? ` · последняя ${item.revision}` : ''}</dd>
          <dt className={T.muted}>Статус</dt><dd><StatusDot status={item.status} config={docs.config} /></dd>
          <dt className={T.muted}>Ответственный</dt><dd>{item.assignee || '—'}</dd>
          <dt className={T.muted}>Срок</dt><dd>{item.dueDate ? new Date(item.dueDate).toLocaleDateString('ru-RU') : '—'}</dd>
          {info.role === 'remarks' && info.link && <><dt className={T.muted}>Код</dt><dd>{info.link.reviewCode || '—'}{info.link.receivedAt ? ` · получен ${new Date(info.link.receivedAt).toLocaleDateString('ru-RU')}` : ''}</dd></>}
        </dl>
      )}
      {info.issue && (
        <p data-doc-issue className={`mt-2 text-xs ${info.issue.changed && info.role === 'file' ? 'text-amber-700 dark:text-amber-400' : T.muted}`}>
          Выдан: ред. {info.issue.revision}, {new Date(`${info.issue.date}T12:00:00Z`).toLocaleDateString('ru-RU')}, причина {info.issue.reason || '—'}.
          {info.role === 'file' && info.issue.changed ? ` Изменён после выпуска ред. ${info.issue.revision}.` : ''}
        </p>
      )}
      {info.role === 'remarks' && info.remarksTo && <p data-doc-return-of className={`mt-1 text-xs ${T.muted}`}>Возврат к выданному файлу «{info.remarksTo.fileName}» (ред. {info.remarksTo.revision}).</p>}
      {info.link?.lostAt && <p role="status" className="mt-2 text-xs text-rose-600 dark:text-rose-400">Файл ред. {info.link.revision} удалён или перемещён.</p>}
      {mismatch?.length ? (
        <div role="alert" className="mt-2 space-y-1 text-xs text-rose-700 dark:text-rose-400">
          <p>Имя файла не совпадает со строкой: {mismatch.join('; ')}.</p>
          <div className="flex flex-wrap gap-2">
            {fix && canFiles && <Btn size="sm" disabled={busy} onClick={() => void rename()}>Переименовать в {fix}</Btn>}
            {canFiles && <Btn size="sm" disabled={busy} onClick={onUnlink}>Отвязать</Btn>}
          </div>
        </div>
      ) : null}
      {revisions.length > 0 && (
        <div className="mt-3 text-xs">
          <p className={`mb-1 ${T.muted}`}>Файлы по ревизиям</p>
          <ul className="space-y-0.5">
            {revisions.map((rev) => {
              const mine = history.filter((l) => l.role === 'file' && l.revision === rev);
              return mine.map((l) => (
                <li key={l.id} className={l.unlinkedAt ? 'text-slate-400 line-through' : ''}>
                  <span className="font-medium">ред. {rev}</span> · {l.fileName}{l.unlinkedAt ? ' · отвязан' : ''}
                  {history.filter((r) => r.role === 'remarks' && r.toLinkId === l.id && !r.unlinkedAt).map((r) => <span key={r.id} className={`block pl-3 ${T.muted}`}>возврат: {r.fileName}{r.reviewCode ? ` (код ${r.reviewCode})` : ''}</span>)}
                </li>
              ));
            })}
          </ul>
        </div>
      )}
      {item && <button type="button" onClick={onOpen} className={`mt-4 rounded px-3 py-2 text-xs ${T.iconButton}`}>Открыть в ДО</button>}
    </section>
  );
}
