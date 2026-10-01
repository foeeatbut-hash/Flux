/**
 * Панель «Данные проекта» в окне Документа и Таблицы Flux Office.
 *
 * Документ, собранный из данных проекта, не должен расходиться с ними: шифр,
 * марка тега, расход установки, ревизия строки ВДР, «Разработал / Проверил»
 * вставляются не текстом, а полем. Поле помнит, откуда значение, и «Обновить
 * поля» подставляет сегодняшнее — одной кнопкой, по всему файлу.
 *
 * Как поле держится в файле (office/fieldKeys.ts, docs/office-project-data.md):
 *   - Документ: вставляется метка {{ключ}}, «Обновить поля» делает из неё поле
 *     Word DOCPROPERTY и ставит значение — поле переживает любую правку;
 *   - Таблица: значение ставится в выделенную ячейку, на ней — имя FLUX_<ключ>.
 * Значения считает сервер (server/routes/projectData.ts), окно только
 * показывает и вставляет.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, RefreshCw, Search, PenLine } from 'lucide-react';
import { Btn, Empty, IconBtn, Input, SectionTitle } from '../ui';
import { SIGN_ROLES, SIGN_TITLES, type SignRole } from '../../../office/fieldKeys';

interface Field { key: string; title: string; value: string }
interface Item { id: string; title: string; hint: string; fields: Field[] }
interface Group { id: string; title: string; items: Item[] }
interface Signer { userId: string; name: string; date: string; source: string }

export interface ProjectDataPanelProps {
  fileId: string;
  projectId?: string;
  kind: 'doc' | 'sheet';
  /** Вставить поле в место курсора (Документ) или в выделенную ячейку (Таблица) */
  onInsert: (field: Field) => Promise<void> | void;
  /** Записать правки, обновить поля файла на сервере и открыть его заново */
  onUpdate: () => Promise<void>;
  onClose: () => void;
  /** Правка сейчас закрыта (смотрит, а правит другой) — вставлять нельзя */
  readOnly?: boolean;
}

export default function ProjectDataPanel({ fileId, projectId, kind, onInsert, onUpdate, onClose, readOnly }: ProjectDataPanelProps) {
  const [q, setQ] = useState('');
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string>('');
  const [signers, setSigners] = useState<Partial<Record<SignRole, Signer>>>({});
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  // Поиск: по вводу, с короткой паузой; поздний ответ не перебивает свежий
  useEffect(() => {
    const my = ++seq.current;
    const t = setTimeout(() => {
      fetch(`/api/project-data/search?${new URLSearchParams({ q, fileId, ...(projectId ? { projectId } : {}) })}`)
        .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d?.error || `сервер ответил ${r.status}`); return d; })
        .then((d) => { if (my === seq.current) { setGroups(d.groups || []); setError(''); } })
        .catch((e) => { if (my === seq.current) setError(String(e.message || e)); });
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, fileId, projectId]);

  useEffect(() => {
    fetch(`/api/project-data/signers?fileId=${encodeURIComponent(fileId)}`).then((r) => r.json()).then((d) => setSigners(d.signers || {})).catch(() => {});
    fetch('/api/users').then((r) => r.json()).then((d) => {
      const list = Array.isArray(d) ? d : d.users || [];
      setUsers(list.map((u: any) => ({ id: String(u.id), name: String(u.name || u.symbol || '') })).filter((u: any) => u.name));
    }).catch(() => {});
  }, [fileId]);

  const setSigner = async (role: SignRole, userId: string) => {
    const r = await fetch('/api/project-data/signers', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId, role, userId: userId || null }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) setSigners(d.signers || {}); else setError(d?.error || 'Подпись не сохранена');
  };

  const update = async () => {
    setBusy(true);
    try { await onUpdate(); } finally { setBusy(false); }
  };

  const signFields = useMemo(() => SIGN_ROLES.flatMap((role) => [
    { key: `sign.${role}.name`, title: `${SIGN_TITLES[role]} — имя`, value: signers[role]?.name || '—' },
    { key: `sign.${role}.date`, title: `${SIGN_TITLES[role]} — дата`, value: signers[role]?.date || '—' },
  ]), [signers]);

  const row = (f: Field) => (
    <div key={f.key} className="fx-li group !h-auto min-h-[40px] py-1" title={f.key}>
      <span className="flex-1 min-w-0">
        <span className="block truncate text-sm">{f.title}</span>
        <span className="block truncate text-xs text-slate-500 dark:text-slate-400">{f.value}</span>
      </span>
      <Btn size="sm" tone="ghost" disabled={readOnly} onClick={() => onInsert(f)}
        title={kind === 'doc' ? 'Вставить поле в место курсора' : 'Вставить поле в выделенную ячейку'}>Вставить</Btn>
    </div>
  );

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l border-slate-200 bg-[var(--flux-surface)] dark:border-slate-800" aria-label="Данные проекта">
      <div className="fx-head">
        <h2 className="fx-head-title">Данные проекта</h2>
        <div className="fx-head-acts"><IconBtn label="Закрыть панель" onClick={onClose}><X /></IconBtn></div>
      </div>
      <div className="px-3 pb-2">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Тег, позиция, шифр, поле" aria-label="Найти в данных проекта" className="w-full pl-7" />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3">
        {error && <p className="py-2 text-sm text-rose-600">{error}</p>}
        {groups === null && !error && <p className="py-4 text-sm text-slate-400">Загрузка…</p>}
        {groups && !groups.length && <Empty title="Ничего не нашлось" text="Попробуйте код тега, позицию или шифр документа." />}
        {groups?.map((g) => (
          <section key={g.id}>
            <SectionTitle>{g.title}</SectionTitle>
            {g.items.map((it) => {
              // Проект и документ раскрыты всегда: их полей мало. Тег и
              // позиция — по щелчку, иначе список уходит на сотни строк
              const always = g.id === 'project' || g.id === 'doc';
              const shown = always || open === `${g.id}:${it.id}`;
              return (
                <div key={it.id}>
                  {!always && (
                    <button type="button" className="fx-li !h-auto min-h-[40px] w-full py-1 text-left" aria-expanded={shown}
                      onClick={() => setOpen(shown ? '' : `${g.id}:${it.id}`)}>
                      <span className="flex-1 min-w-0">
                        <span className="block truncate text-sm font-medium">{it.title}</span>
                        {it.hint && <span className="block truncate text-xs text-slate-500 dark:text-slate-400">{it.hint}</span>}
                      </span>
                    </button>
                  )}
                  {shown && <div className={always ? '' : 'pl-3'}>{it.fields.map(row)}</div>}
                </div>
              );
            })}
          </section>
        ))}
        <section className="pb-3">
          <SectionTitle>Подписи</SectionTitle>
          {SIGN_ROLES.map((role) => (
            <div key={role} className="fx-li">
              <PenLine className="h-3.5 w-3.5 text-slate-400" />
              <span className="w-20 shrink-0 text-sm">{SIGN_TITLES[role]}</span>
              <select className="fx-input min-w-0 flex-1" aria-label={SIGN_TITLES[role]} disabled={readOnly}
                value={signers[role]?.userId || ''} onChange={(e) => void setSigner(role, e.target.value)}>
                <option value="">—</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
          ))}
          {signFields.map(row)}
        </section>
      </div>
      <div className="flex items-center gap-2 border-t border-slate-200 p-3 dark:border-slate-800">
        <Btn tone="primary" disabled={busy || readOnly} onClick={update}
          title="Подставить сегодняшние значения во все поля файла"><RefreshCw />Обновить поля</Btn>
        {busy && <span className="text-xs text-slate-400">Обновляются…</span>}
      </div>
    </aside>
  );
}
