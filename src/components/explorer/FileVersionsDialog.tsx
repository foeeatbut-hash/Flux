/**
 * «Версии…» файла Flux Office: прежние содержимые и возврат к ним.
 *
 * Откат копится сам — каждое сохранение Документа, Таблицы, PDF и Блокнота
 * кладёт прежнее содержимое в версию (server/routes/officeFiles.ts). Здесь их
 * видно и можно вернуть. Восстановление — обычная запись: нынешнее содержимое
 * тоже уходит в версию, так что передумать можно. Открытый файл сервер не
 * трогает — об этом скажет ответ 423.
 */
import React, { useEffect, useState } from 'react';
import { Btn, Dialog, Empty } from '../ui';
import { useToastStore } from '../../store/toastStore';
import { useModalStore } from '../../store/modalStore';

interface Version { id: string; version: number; size: number; createdById: string | null; createdAt: string }

const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} КБ` : `${(n / 1024 / 1024).toFixed(1)} МБ`);
const when = (s: string) => new Date(s).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export default function FileVersionsDialog({ fileId, name, onClose, onRestored }: {
  fileId: string; name: string;
  onClose: () => void; onRestored: () => void;
}) {
  const { addToast } = useToastStore();
  const { openConfirm } = useModalStore();
  const [list, setList] = useState<Version[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    fetch('/api/users').then((r) => r.json()).then((d) => {
      const all = Array.isArray(d) ? d : d.users || [];
      setUsers(all.map((u: any) => ({ id: String(u.id), name: String(u.name || u.symbol || '') })));
    }).catch(() => {});
  }, []);

  const load = () => fetch(`/api/office/files/${encodeURIComponent(fileId)}/versions`)
    .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d?.error || `сервер ответил ${r.status}`); return d; })
    .then((d) => { setList(d.versions || []); setError(''); })
    .catch((e) => setError(String(e?.message || e)));
  useEffect(() => { void load(); }, [fileId]);

  const who = (id: string | null) => users.find((u) => u.id === id)?.name || '—';

  const restore = async (v: Version) => {
    const ok = await openConfirm('Вернуть версию', `Содержимое «${name}» станет таким, каким было в версии ${v.version} (${when(v.createdAt)}). Нынешнее не пропадёт — оно уйдёт в версии.`);
    if (!ok) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/office/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(v.id)}/restore`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { addToast(d?.error || `Не вернулось: сервер ответил ${r.status}`, 'error'); return; }
      addToast(`«${name}»: возвращена версия ${v.version}`, 'success');
      onRestored();
      await load();
    } finally { setBusy(false); }
  };

  const download = async (v: Version) => {
    const r = await fetch(`/api/office/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(v.id)}/raw`);
    if (!r.ok) { addToast('Версию не удалось получить', 'error'); return; }
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = decodeURIComponent(r.headers.get('X-File-Name') || name);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };

  return (
    <Dialog title={`Версии — ${name}`} onClose={onClose} busy={busy} width="max-w-lg"
      footer={<Btn onClick={onClose} disabled={busy}>Закрыть</Btn>}>
      {error && <p className="text-sm text-rose-600">{error}</p>}
      {!error && list === null && <p className="text-sm text-slate-400">Загрузка…</p>}
      {list && !list.length && <Empty title="Версий пока нет" text="Версия появляется, когда файл сохраняют в Flux Office: прежнее содержимое уходит в неё." />}
      {list && list.length > 0 && (
        <div className="-mx-2">
          {list.map((v) => (
            <div key={v.id} className="fx-li group">
              <span className="w-14 shrink-0 text-sm font-medium">Версия {v.version}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-slate-500 dark:text-slate-400">{when(v.createdAt)} · {who(v.createdById)} · {kb(v.size)}</span>
              <span className="fx-row-acts">
                <Btn size="sm" tone="ghost" onClick={() => void download(v)} disabled={busy}>Скачать</Btn>
                <Btn size="sm" tone="ghost" onClick={() => void restore(v)} disabled={busy}>Вернуть</Btn>
              </span>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
