/**
 * Подтверждение публикации: что, куда и «Оставить копию в черновиках».
 *
 * Окно одно на всю программу: его открывают перетаскивание на папку в
 * Проводнике и дереве, пункт «Опубликовать в проект…» и «Разобрать старые».
 * Файл публикуется только после подтверждения — перенос из панели в папку
 * проекта не должен случиться от неточного движения мыши.
 */
import React from 'react';
import { Btn, Dialog } from '../ui';
import { folderLabel, publishDraftInPlace, publishDraftInto } from '../../lib/draftsActions';
import { windowsFilesRequest, type WindowsRoot } from '../../lib/windowsFiles';
import { readablePath } from '../../lib/fluxSaveWrite';
import { useDraftsPanelStore } from '../../store/draftsPanelStore';
import { useDraftsPublishStore } from '../../store/draftsPublishStore';
import { useToastStore } from '../../store/toastStore';

export default function DraftPublishDialog() {
  const request = useDraftsPublishStore((s) => s.request);
  const clear = useDraftsPublishStore((s) => s.clear);
  const [roots, setRoots] = React.useState<WindowsRoot[]>([]);
  const [keepCopy, setKeepCopy] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { setKeepCopy(!!request?.keepCopy); }, [request]);
  React.useEffect(() => {
    if (!request) return;
    let active = true;
    void windowsFilesRequest<WindowsRoot[]>({ action: 'roots' }).then((answer) => { if (active && 'data' in answer) setRoots(answer.data); });
    return () => { active = false; };
  }, [request]);
  if (!request) return null;
  const { items, parent } = request;
  const rootName = (id: string) => roots.find((root) => root.id === id)?.name || 'Папка Windows';
  const where = parent ? readablePath(rootName(parent.rootId), parent.relativePath) : 'папка, где черновик лежит сейчас';
  const blocked = !!parent?.draftId;
  const many = items.length > 1;
  const submit = async () => {
    setBusy(true);
    const send = windowsFilesRequest;
    const messages: string[] = [];
    let failed = 0;
    for (const item of items) {
      const outcome = parent ? await publishDraftInto(send, item, parent, { keepCopy }) : await publishDraftInPlace(send, item);
      if (!outcome.ok) { failed++; messages.push(outcome.message); }
      else if (!many) messages.push(outcome.message);
    }
    setBusy(false);
    clear();
    void useDraftsPanelStore.getState().reload();
    const add = useToastStore.getState().addToast;
    if (failed) add(many ? `Опубликовано ${items.length - failed} из ${items.length}. ${messages[0]}` : messages[0], 'error');
    else add(many ? `Опубликовано черновиков: ${items.length}.` : messages[0], 'success');
  };
  return <Dialog title="Опубликовать в проект" onClose={() => { if (!busy) clear(); }} busy={busy} width="max-w-md"
    footer={<><Btn size="sm" onClick={clear} disabled={busy}>Отмена</Btn><Btn size="sm" tone="primary" onClick={() => void submit()} disabled={busy || blocked}>Опубликовать</Btn></>}>
    <dl data-draft-publish className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-1">
      <dt className="text-[var(--flux-text-muted)]">Что</dt>
      <dd className="truncate text-[var(--flux-text)]" title={items.map((item) => item.name).join(', ')}>{many ? `${items.length} черновиков` : `«${items[0].name}»`}</dd>
      <dt className="text-[var(--flux-text-muted)]">Куда</dt>
      <dd className="break-words text-[var(--flux-text)]" title={where}>{parent ? <>«{folderLabel(parent.relativePath, rootName(parent.rootId))}» <span className="text-[var(--flux-text-muted)]">· {where}</span></> : where}</dd>
    </dl>
    {blocked
      ? <p role="alert" className="mt-2 text-[var(--flux-bad-text)]">Эта папка ещё не опубликована в Windows. Выберите обычную папку.</p>
      : <p className="mt-2 text-xs text-[var(--flux-text-muted)]">Файл станет обычным файлом Windows. Если имя занято, появится номер: «Документ (2)».</p>}
    {parent && <label className="mt-2 flex items-center gap-2 text-[var(--flux-text)]">
      <input type="checkbox" checked={keepCopy} disabled={busy} onChange={(event) => setKeepCopy(event.target.checked)} />Оставить копию в черновиках
    </label>}
  </Dialog>;
}
