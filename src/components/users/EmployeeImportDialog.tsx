import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { Download, FileSpreadsheet } from 'lucide-react';
import { Btn, Dialog, Select } from '../ui';
import type { Role } from '../../lib/roles';
import { useStore } from '../../store/store';
import { useModalStore } from '../../store/modalStore';
import { guardClose } from '../../lib/closeGuard';
import { usePaneId } from '../../lib/paneTitle';
import ImportFileChooser from '../ImportFileChooser';

type Field = 'symbol' | 'lastName' | 'firstName' | 'middleName' | 'name' | 'role' | 'position' | 'department' | 'email' | 'password';
type PreviewRow = { row: number; values: Record<Field, string>; error?: string; action: 'create' | 'update'; existingId?: string };
type SavedUndo = { token: string; savedAt: number };
const UNDO_LIFETIME = 60 * 60 * 1000;
const fields: Array<{ key: Field; label: string }> = [
  { key: 'symbol', label: 'Табельный номер / логин' }, { key: 'lastName', label: 'Фамилия' }, { key: 'firstName', label: 'Имя' },
  { key: 'middleName', label: 'Отчество' }, { key: 'name', label: 'ФИО целиком' }, { key: 'role', label: 'Роль доступа' },
  { key: 'position', label: 'Должность' }, { key: 'department', label: 'Отдел' }, { key: 'email', label: 'Электронная почта' }, { key: 'password', label: 'Начальный пароль' },
];

export default function EmployeeImportDialog({ roles, onClose, onComplete }: { roles: Role[]; onClose: () => void; onComplete: () => void }) {
  const actorId = useStore((s) => s.user?.id);
  const actorRole = useStore((s) => s.user?.role);
  const paneId = usePaneId();
  const [matrix, setMatrix] = useState<unknown[][]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Partial<Record<Field, number>>>({});
  const [mode, setMode] = useState<'create' | 'update'>('create');
  const [defaultRole, setDefaultRole] = useState('ENGINEER_VENT');
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [credentials, setCredentials] = useState<Array<{ symbol: string; password: string }> | null>(null);
  const [credentialsDownloaded, setCredentialsDownloaded] = useState(false);
  const [undoToken, setUndoToken] = useState('');
  const [appliedCount, setAppliedCount] = useState<number | null>(null);
  const selectable = useMemo(() => preview.filter((r) => !r.error).map((r) => r.row), [preview]);
  const roleOptions = roles.filter((r) => r.code !== 'OWNER' && (r.code !== 'ADMIN' || actorRole === 'OWNER')).map((r) => ({ value: r.code, label: r.name }));
  const storageKey = actorId ? `flux_employee_import_undo_${actorId}` : '';

  useEffect(() => {
    setUndoToken('');
    if (!storageKey) return;
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null') as SavedUndo | null;
      const age = saved ? Date.now() - saved.savedAt : Infinity;
      if (saved && typeof saved.token === 'string' && saved.token && Number.isFinite(saved.savedAt) && age >= 0 && age < UNDO_LIFETIME) {
        setUndoToken(saved.token);
      } else { try { localStorage.removeItem(storageKey); } catch { /* Недоступное хранилище не мешает импорту. */ } }
    } catch { try { localStorage.removeItem(storageKey); } catch { /* Недоступное хранилище не мешает импорту. */ } }
  }, [storageKey]);

  const previousActor = useRef(actorId);
  useEffect(() => {
    if (previousActor.current === actorId) return;
    previousActor.current = actorId;
    setCredentials(null); setCredentialsDownloaded(false); setAppliedCount(null);
    setMatrix([]); setHeaders([]); setMapping({}); setPreview([]); setSelected([]);
  }, [actorId]);

  useEffect(() => {
    if (!paneId.startsWith('win:')) return;
    return guardClose(paneId.slice(4), async () => {
      if (busy || useModalStore.getState().currentModal) return false;
      if (!credentials?.length || credentialsDownloaded) return true;
      return useModalStore.getState().openConfirm('Не скачаны начальные пароли', 'Если закрыть окно, начальные пароли исчезнут и повторно не покажутся. Закрыть окно?', { confirmLabel: 'Закрыть', tone: 'danger' });
    });
  }, [paneId, busy, credentials, credentialsDownloaded]);

  const clearPreview = () => { setPreview([]); setSelected([]); };
  const requestClose = async () => {
    if (busy || useModalStore.getState().currentModal) return;
    if (credentials?.length && !credentialsDownloaded) {
      const confirmed = await useModalStore.getState().openConfirm('Не скачаны начальные пароли', 'Если закрыть окно, начальные пароли исчезнут и повторно не покажутся. Закрыть окно?', { confirmLabel: 'Закрыть', tone: 'danger' });
      if (!confirmed) return;
    }
    onClose();
  };

  const loadFile = async (file?: File) => {
    if (!file || busy || useModalStore.getState().currentModal) return;
    if (credentials?.length && !credentialsDownloaded) {
      const confirmed = await useModalStore.getState().openConfirm('Не скачаны начальные пароли', 'При замене файла текущие начальные пароли исчезнут. Сначала скачайте их или подтвердите замену.', { confirmLabel: 'Заменить файл', tone: 'danger' });
      if (!confirmed) return;
    }
    setBusy(true); setError(''); setMatrix([]); setHeaders([]); setMapping({}); clearPreview(); setCredentials(null); setCredentialsDownloaded(false); setAppliedCount(null);
    if (file.size > 10 * 1024 * 1024) { setError('Файл больше 10 МБ'); setBusy(false); return; }
    try {
      const bytes = await file.arrayBuffer();
      const book = XLSX.read(bytes, { type: 'array', raw: true });
      const sheet = book.Sheets[book.SheetNames[0]];
      if (!sheet) throw new Error('В файле нет листа с данными');
      const data = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: false, blankrows: false });
      if (data.length < 2 || data.length > 5001) throw new Error('Нужно от 1 до 5000 строк данных');
      const head = (data[0] || []).map((v, i) => String(v || `Колонка ${i + 1}`));
      const aliases: Record<string, Field> = { 'логин': 'symbol', 'табельный номер': 'symbol', 'номер': 'symbol', 'фамилия': 'lastName', 'имя': 'firstName', 'отчество': 'middleName', 'фио': 'name', 'роль': 'role', 'должность': 'position', 'отдел': 'department', 'email': 'email', 'почта': 'email', 'электронная почта': 'email', 'пароль': 'password' };
      const next: Partial<Record<Field, number>> = {};
      head.forEach((h, i) => { const key = aliases[h.trim().toLocaleLowerCase('ru-RU')]; if (key && next[key] === undefined) next[key] = i; });
      setHeaders(head); setMatrix(data); setMapping(next);
    } catch (e: any) { setError(e?.message || 'Не удалось прочитать таблицу'); }
    finally { setBusy(false); }
  };

  const runPreview = async () => {
    const requestActor = actorId;
    setBusy(true); setError('');
    try {
      const r = await fetch('/api/users/import/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows: matrix, mapping, mode, defaultRole }) });
      const body = await r.json(); if (!r.ok) throw new Error(body.message || 'Предпросмотр не выполнен');
      if (useStore.getState().user?.id !== requestActor) return;
      setPreview(body.rows); setSelected(body.rows.filter((x: PreviewRow) => !x.error).map((x: PreviewRow) => x.row));
    } catch (e: any) { setError(e?.message || 'Предпросмотр не выполнен'); }
    finally { setBusy(false); }
  };

  const apply = async () => {
    if (!selected.length || appliedCount !== null) return;
    const requestActor = actorId;
    setBusy(true); setError('');
    try {
      const r = await fetch('/api/users/import/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows: matrix, mapping, selected, mode, defaultRole }) });
      const body = await r.json(); if (!r.ok) throw new Error(body.message || 'Импорт не выполнен');
      if (useStore.getState().user?.id !== requestActor) return;
      const token = body.undoToken || '';
      setCredentials(body.credentials || []); setCredentialsDownloaded(false); setUndoToken(token); setAppliedCount(body.imported ?? 0);
      if (token && storageKey) {
        try { localStorage.setItem(storageKey, JSON.stringify({ token, savedAt: Date.now() } satisfies SavedUndo)); }
        catch { /* Серверная отмена доступна до закрытия окна, даже если хранилище браузера недоступно. */ }
      }
      onComplete();
    } catch (e: any) { setError(e?.message || 'Импорт не выполнен'); }
    finally { setBusy(false); }
  };

  const undo = async () => {
    if (!undoToken) return;
    const requestActor = actorId;
    setBusy(true); setError('');
    try {
      const r = await fetch('/api/users/import/undo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ undoToken }) });
      const body = await r.json(); if (!r.ok) throw new Error(body.message || 'Отмена не выполнена');
      if (useStore.getState().user?.id !== requestActor) return;
      if (storageKey) { try { localStorage.removeItem(storageKey); } catch { /* Повтор отмены больше не нужен после ответа сервера. */ } }
      setUndoToken(''); setCredentials(null); setCredentialsDownloaded(false); setAppliedCount(null); setPreview([]); setSelected([]); onComplete();
    } catch (e: any) { setError(e?.message || 'Отмена не выполнена'); }
    finally { setBusy(false); }
  };

  const downloadCredentials = () => {
    if (!credentials) return;
    const cell = (value: string) => `"${(/^[=+\-@\t\r]/.test(value) ? `'${value}` : value).replaceAll('"', '""')}"`;
    const csv = '\uFEFF' + ['Табельный номер;Начальный пароль', ...credentials.map((c) => `${cell(c.symbol)};${cell(c.password)}`)].join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'Начальные-пароли-сотрудников.csv'; a.click(); URL.revokeObjectURL(url);
    setCredentialsDownloaded(true);
  };
  const downloadTemplate = () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Табельный номер', 'Фамилия', 'Имя', 'Отчество', 'Роль', 'Должность', 'Отдел', 'Электронная почта'], ['001', 'Иванов', 'Иван', 'Иванович', 'ENGINEER_VENT', 'Инженер', 'Проектный отдел', 'ivan@example.ru']]), 'Сотрудники');
    XLSX.writeFile(book, 'Шаблон-импорта-сотрудников.xlsx');
  };

  return <Dialog title="Импорт сотрудников" width="max-w-5xl" scrollBody onClose={() => void requestClose()} busy={busy} footer={<><Btn disabled={busy} onClick={() => void requestClose()}>Закрыть</Btn>{!preview.length && <Btn tone="primary" disabled={busy || matrix.length < 2 || typeof mapping.symbol !== 'number' || (mode === 'create' && typeof mapping.name !== 'number' && (typeof mapping.lastName !== 'number' || typeof mapping.firstName !== 'number'))} onClick={() => void runPreview()}>Показать предпросмотр</Btn>}{preview.length > 0 && appliedCount === null && <Btn tone="primary" disabled={busy || !selected.length} onClick={() => void apply()}>Импортировать {selected.length}</Btn>}{credentials?.length ? <Btn tone="primary" disabled={busy} onClick={downloadCredentials}><Download />Скачать пароли CSV</Btn> : null}{undoToken && <Btn tone="danger" disabled={busy} onClick={() => void undo()}>Отменить импорт</Btn>}</>}>
    <div className="space-y-4">
      <div className="flex flex-col items-start gap-2 sm:flex-row sm:flex-wrap sm:items-center"><Btn disabled={busy} onClick={downloadTemplate}><FileSpreadsheet />Скачать шаблон XLSX</Btn><ImportFileChooser accept=".xlsx,.xls,.csv" disabled={busy} label="Выбрать XLSX или CSV" onFiles={files => { if (files[0]) void loadFile(files[0]); }} /><span className="text-xs text-slate-500 dark:text-slate-400">До 5000 строк и 10 МБ. Пароли не отправляются в журналы.</span></div>
      {headers.length > 0 && <>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2"><label className="fx-field"><span className="fx-label">Действие</span><select disabled={busy || appliedCount !== null} className="fx-input" value={mode} onChange={(e) => { setMode(e.target.value as any); clearPreview(); }}><option value="create">Создать новых сотрудников</option><option value="update">Обновить существующих по логину</option></select></label><label className="fx-field"><span className="fx-label">Роль по умолчанию для новых строк</span><Select disabled={busy || appliedCount !== null} value={defaultRole} onChange={(value) => { setDefaultRole(value); clearPreview(); }} options={roleOptions} /></label></div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">{fields.map(({ key, label }) => <label key={key} className="fx-field"><span className="fx-label">{label}{['symbol', 'name', 'lastName', 'firstName'].includes(key) ? ' *' : ''}</span><select disabled={busy || appliedCount !== null} className="fx-input" value={mapping[key] ?? ''} onChange={(e) => { setMapping((m) => ({ ...m, [key]: e.target.value === '' ? undefined : Number(e.target.value) })); clearPreview(); }}><option value="">Не использовать</option>{headers.map((h, i) => <option key={`${i}-${h}`} value={i}>{h}</option>)}</select></label>)}</div>
        {preview.length > 0 && <><div className="text-sm text-slate-600 dark:text-slate-300">Строк к импорту: {preview.length}; корректных: {selectable.length}. Пустые ячейки при обновлении сохраняют прежние значения.</div><div className="max-h-72 overflow-auto rounded border border-slate-200 dark:border-slate-700"><table className="fx-table min-w-[640px]"><thead><tr><th><input aria-label="Выбрать все корректные строки" type="checkbox" disabled={busy || appliedCount !== null} checked={selected.length === selectable.length && selectable.length > 0} onChange={(e) => setSelected(e.target.checked ? selectable : [])} /></th><th>Строка</th><th>Логин</th><th>Сотрудник</th><th>Роль доступа</th><th>Результат</th></tr></thead><tbody>{preview.map((r) => <tr key={r.row}><td><input type="checkbox" aria-label={`Выбрать строку ${r.row}`} disabled={busy || !!r.error || appliedCount !== null} checked={selected.includes(r.row)} onChange={(e) => setSelected((s) => e.target.checked ? [...s, r.row] : s.filter((n) => n !== r.row))} /></td><td>{r.row}</td><td>{r.values.symbol}</td><td>{r.values.name || [r.values.lastName, r.values.firstName, r.values.middleName].filter(Boolean).join(' ')}</td><td>{r.values.role}</td><td className={r.error ? 'text-rose-600 dark:text-rose-400' : ''}>{r.error || (r.action === 'update' ? 'Обновить' : 'Создать')}</td></tr>)}</tbody></table></div></>}
      </>}
      {credentials?.length ? <p className="rounded bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">Создано сотрудников: {credentials.length}. Скачайте CSV с начальными паролями сейчас: повторно они не показываются.</p> : null}
      {appliedCount !== null && !credentials?.length && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">Импортировано сотрудников: {appliedCount}.</p>}
      {undoToken && <p className="text-xs text-slate-500 dark:text-slate-400">Импорт можно отменить в течение часа. Отмена остановится, если импортированные профили уже изменились или привязаны к другим данным.</p>}
      {error && <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}
    </div>
  </Dialog>;
}
