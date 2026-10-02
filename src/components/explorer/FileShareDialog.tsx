import React, { useEffect, useState } from 'react';
import { dataService, type User } from '../../services/dataService';
import { getFileShare, getSourceShare, localSourceKey, setFileSharing, sourceBindings, stageLocalShare, syncSource, type ShareState } from '../../services/fileSharingService';
import type { WindowsFileRef } from '../../lib/windowsFiles';
import { Btn, Dialog, Field, Input, Select } from '../ui';

export default function FileShareDialog({ actorId, name, source, fileId, onClose, onChanged }: {
  actorId: string; name: string; source?: WindowsFileRef; fileId?: string; onClose: () => void; onChanged?: () => void;
}) {
  const [state, setState] = useState<ShareState | null>(null);
  const [people, setPeople] = useState<User[]>([]);
  const [audience, setAudience] = useState<ShareState['audience']>('NONE');
  const [permission, setPermission] = useState<ShareState['permission']>('EDIT');
  const [recipients, setRecipients] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [users, existing] = await Promise.all([dataService.getUsers(), fileId ? getFileShare(fileId) : source ? localSourceKey(actorId, source).then(getSourceShare) : Promise.resolve(null)]);
        if (!alive) return;
        setPeople(users.filter((person) => person.id !== actorId));
        if (existing) { setState(existing); setAudience(existing.audience); setPermission(existing.permission); setRecipients(existing.recipients); }
      } catch (err: any) { if (alive) setError(err?.message || 'Не удалось прочитать настройки доступа'); }
      finally { if (alive) setBusy(false); }
    })();
    return () => { alive = false; };
  }, [actorId, fileId, source?.rootId, source?.relativePath, source?.draftId]);
  const save = async (chosenAudience = audience) => {
    if (chosenAudience === 'NONE' && !state) { setStatus('Файл остаётся личным.'); return; }
    setBusy(true); setError(''); setStatus('');
    try {
      const staged = state?.state === 'READY' ? state : source ? await stageLocalShare(actorId, source, setStatus) : state;
      if (!staged) throw Error('Не найден исходный файл');
      setState(staged);
      const next = await setFileSharing(staged, { audience: chosenAudience, permission, recipients });
      setState(next); setAudience(next.audience); onChanged?.();
      setStatus(chosenAudience === 'NONE' ? 'Общий доступ отключён. Последняя общая версия сохранена на сервере компании.' : 'Общий доступ включён. Файл доступен из папки «Общий доступ».');
      const binding = sourceBindings(actorId).find((item) => item.fileId === next.fileId);
      if (binding) { const message = await syncSource(actorId, binding); if (message !== 'Синхронизировано') setStatus(message); }
    } catch (err: any) { setError(err?.message || 'Не удалось изменить общий доступ'); }
    finally { setBusy(false); }
  };
  return <Dialog title={`Общий доступ · ${name}`} onClose={onClose} busy={busy} width="max-w-lg" footer={<>
    {state?.audience !== 'NONE' && state?.state === 'READY' && <Btn tone="danger" disabled={busy} onClick={() => void save('NONE')}>Отключить общий доступ</Btn>}
    <span className="flex-1" /><Btn disabled={busy} onClick={onClose}>Закрыть</Btn><Btn tone="primary" disabled={busy || audience === 'USERS' && !recipients.length} onClick={() => void save()}>{busy ? 'Сохранение…' : 'Предоставить доступ'}</Btn>
  </>}>
    <div className="flex flex-col gap-3">
      <Field label="Кому доступен файл"><Select value={audience} onChange={(value) => setAudience(value as ShareState['audience'])} options={[{ value: 'NONE', label: 'Только я' }, { value: 'USERS', label: 'Выбранные сотрудники' }, { value: 'ALL', label: 'Все сотрудники' }]} /></Field>
      {audience !== 'NONE' && <Field label="Разрешение"><Select value={permission} onChange={(value) => setPermission(value as ShareState['permission'])} options={[{ value: 'EDIT', label: 'Редактирование' }, { value: 'VIEW', label: 'Просмотр' }]} /></Field>}
      {audience === 'USERS' && <Field label={`Получатели · ${recipients.length}`}><Input placeholder="Найти сотрудника" value={search} onChange={(e) => setSearch(e.target.value)} /><div className="max-h-48 overflow-y-auto">{people.filter((person) => person.name.toLocaleLowerCase('ru').includes(search.trim().toLocaleLowerCase('ru'))).map((person) => <label className="flex items-center gap-2 min-h-8 text-xs" key={person.id}><input type="checkbox" checked={recipients.includes(person.id)} disabled={busy} onChange={(e) => setRecipients(e.target.checked ? [...new Set([...recipients, person.id])] : recipients.filter((id) => id !== person.id))} />{person.name}</label>)}</div></Field>}
      <p className="fx-hint">Оригинал остаётся на вашем компьютере. Общая рабочая версия хранится на сервере компании и доступна коллегам, когда ваш компьютер выключен.</p>
      {status && <p className="fx-hint" role="status">{status}</p>}{error && <p className="fx-error" role="alert">{error}</p>}
    </div>
  </Dialog>;
}
