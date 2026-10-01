import React from 'react';
import { useStore } from '../../store/store';
import { canAdmin } from '../../lib/permissions';
import { activateLicense, licenseRequest, type LicenseStatus } from '../../lib/license';
import SectionShell from './SectionShell';

type Overview = { installationId: string; people: Array<LicenseStatus & { id: string; symbol: string; name: string; isActive: boolean }>; revocationSequence: number; revokedCount: number };

export default function LicenseSection() {
  const user = useStore(s => s.user);
  const permitted = canAdmin(user, 'admin.license.activate');
  const [overview, setOverview] = React.useState<Overview | null>(null);
  const [organization, setOrganization] = React.useState('');
  const [request, setRequest] = React.useState('');
  const [code, setCode] = React.useState('');
  const [revoke, setRevoke] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [selected, setSelected] = React.useState<string[]>([]);
  const load = React.useCallback(async () => {
    if (!permitted) return;
    try { setOverview(await licenseRequest<Overview>('overview')); }
    catch (e: any) { setError(e.message); }
  }, [permitted, user?.id]);
  React.useEffect(() => { void load(); }, [load]);
  if (!permitted) return null;
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setMessage('');
    try { await action(); } catch (e: any) { setError(e.message || 'Не удалось выполнить действие'); }
    finally { setBusy(false); }
  };
  const generate = async () => {
    const params = new URLSearchParams({ organization });
    if (selected.length) params.set('people', selected.join(','));
    const response = await licenseRequest<{ code: string; count: number }>(`request?${params}`);
    setRequest(response.code); setMessage(`В запросе ${response.count} сотрудников. Передайте код владельцу Flux.`);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(request); setMessage('Код запроса скопирован. Передайте его владельцу Flux.'); }
    catch (_) { setMessage('Буфер недоступен. Выделите и скопируйте код вручную.'); }
  };
  return <SectionShell title="Лицензия компании" desc="Один подписанный ключ открывает работу перечисленным сотрудникам на сервере компании. После окончания срока остаётся чтение.">
    <div className="space-y-4 text-sm text-slate-800 dark:text-dark-text-main">
      {overview && <p className="text-xs text-slate-500 dark:text-slate-400 break-all">Установка компании: <span className="select-all font-mono">{overview.installationId}</span></p>}
      <div className="overflow-x-auto max-h-64 overflow-y-auto border border-slate-200 dark:border-slate-700 rounded">
        <table className="w-full text-xs"><thead className="sticky top-0 bg-slate-100 dark:bg-slate-900"><tr><th className="text-left p-2 font-medium">Выбрать</th><th className="text-left p-2 font-medium">Сотрудник</th><th className="text-left p-2 font-medium">Состояние</th><th className="text-left p-2 font-medium whitespace-nowrap">Срок</th></tr></thead><tbody>{overview?.people.map(p => <tr key={p.id} className="border-t border-slate-200 dark:border-slate-700"><td className="p-2"><input type="checkbox" aria-label={`Выбрать ${p.name}`} checked={selected.includes(p.id)} onChange={e => setSelected(v => e.target.checked ? [...v, p.id] : v.filter(id => id !== p.id))} /></td><td className="p-2">{p.name || p.symbol}<div className="text-slate-500 dark:text-slate-400">{p.symbol}</div></td><td className="p-2">{!p.isActive ? 'Профиль отключён' : p.licensed ? 'Действует' : p.readOnly ? 'Только чтение' : p.reason === 'revoked' ? 'Отозвана' : 'Нет лицензии'}</td><td className="p-2 whitespace-nowrap">{p.expiresAt ? new Date(p.expiresAt).toLocaleDateString('ru-RU') : '—'}</td></tr>)}</tbody></table>
      </div>
      <div className="space-y-2"><label className="block text-xs" htmlFor="license-org">Название компании для запроса</label><input id="license-org" maxLength={200} className="fx-input w-full" value={organization} onChange={e => setOrganization(e.target.value)} /><div className="flex flex-wrap gap-2"><button className="fx-btn" disabled={busy} onClick={() => void run(generate)}>{selected.length ? 'Запрос на выбранных сотрудников' : 'Запрос на сотрудников без лицензии'}</button><button className="fx-btn" disabled={busy} onClick={() => void load()}>Обновить список</button></div><p className="text-xs text-slate-500 dark:text-slate-400">Без выбора строк запрос включает сотрудников без лицензии и тех, кому осталось до 14 дней.</p>
        {request && <><textarea aria-label="Код запроса" readOnly rows={3} className="fx-input w-full font-mono text-xs break-all resize-y" value={request} /><button className="fx-btn" onClick={() => void copy()}>Копировать запрос</button></>}
      </div>
      <div className="space-y-2"><label className="block text-xs" htmlFor="license-key">Ключ от владельца</label><textarea id="license-key" rows={3} className="fx-input w-full font-mono text-xs break-all resize-y" value={code} placeholder="FLUX2.…" onChange={e => setCode(e.target.value)} /><button className="fx-btn-primary" disabled={busy || !code.trim()} onClick={() => void run(async () => { const response: any = await activateLicense(code.trim()); setCode(''); setMessage(`Лицензии активированы для ${response.activated?.employees || 0} сотрудников.`); await load(); })}>Активировать ключ</button></div>
      {user?.role === 'OWNER' && <details><summary className="cursor-pointer text-xs">Отзыв лицензий</summary><p className="text-xs py-2 text-slate-500 dark:text-slate-400">Вставьте подписанный полный список из программы владельца. Применённый список нельзя откатить. Отозвано ключей: {overview?.revokedCount || 0}; выпуск: {overview?.revocationSequence || 0}.</p><textarea rows={3} aria-label="Подписанный список отзыва" value={revoke} onChange={e => setRevoke(e.target.value)} placeholder="FLUXREV1.…" className="fx-input w-full font-mono text-xs break-all resize-y" /><button className="fx-btn mt-2" disabled={busy || !revoke.trim()} onClick={() => void run(async () => { await licenseRequest('revocations', { code: revoke.trim() }); setRevoke(''); setMessage('Подписанный список отзыва применён.'); await load(); })}>Применить отзыв</button></details>}
      {error && <p role="alert" className="text-xs text-rose-700 dark:text-rose-300">{error}</p>}{message && <p role="status" className="text-xs text-slate-700 dark:text-slate-300">{message}</p>}
    </div>
  </SectionShell>;
}
