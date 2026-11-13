/**
 * «Лицензии»: выпуск лицензии по коду запроса компании, готовый ключ и реестр выданных с отзывом.
 * Перенесено из прежнего окна лицензий без изменения поведения: подписывает главный процесс, окно только показывает.
 */
import React, { useMemo, useState } from 'react';
import { call } from './api';
import { Badge, Btn, ErrorLine, Field, useAction } from './ui';
import { displayDate, expiryAfter } from './useLicenses';
import type { LicensesState } from './types';

interface Parsed { inst: string; org: string; people: Array<{ login: string; name: string }> }
const PAGE = 25;

export default function LicenseIssue({ state, reload }: { state: LicensesState; reload: () => Promise<void> }) {
  const [code, setCode] = useState('');
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [company, setCompany] = useState('');
  const [duration, setDuration] = useState('12');
  const [expiration, setExpiration] = useState(expiryAfter(12));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [issued, setIssued] = useState('');
  const [revocation, setRevocation] = useState('');
  const [notice, setNotice] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const action = useAction();
  const backup = state.kind === 'backup';

  const people = useMemo(() => (parsed?.people || []).filter(p => `${p.login} ${p.name}`.toLowerCase().includes(filter.toLowerCase())), [parsed, filter]);
  const read = async () => {
    const done = await action.run(() => call<Parsed>('licenseRequest', { code }));
    if (!done) return;
    setParsed(done.value); setSelected(new Set(done.value.people.map(p => p.login))); setCompany(done.value.org); setNotice('Запрос прочитан. Проверьте компанию, сотрудников и срок.');
  };
  const chooseDuration = (value: string) => { setDuration(value); if (value !== 'custom') setExpiration(expiryAfter(Number(value))); };
  const issue = async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiration)) { setNotice('Выберите дату окончания.'); return; }
    const done = await action.run(() => call<{ code: string }>('issue', { code, logins: [...selected], org: company, expiresAt: new Date(`${expiration}T23:59:59.999`).getTime() }));
    if (!done) return;
    setIssued(done.value.code); setRevocation(''); setNotice('Лицензия выпущена и сохранена в зашифрованном реестре.'); await reload();
  };
  const copy = async (text: string, message: string) => { if (await action.run(() => call('copy', { text }))) setNotice(message); };

  const rows = state.licenses.filter(p => `${p.org} ${p.inst} ${p.logins.join(' ')}`.toLowerCase().includes(search.toLowerCase())).slice().reverse();
  const pages = Math.max(1, Math.ceil(rows.length / PAGE)), at = Math.min(page, pages - 1);
  const isRevoked = (p: { inst: string; id: string }) => state.revocations.some(r => r.inst === p.inst && r.ids.includes(p.id));
  const revoke = async () => {
    const chosen = state.licenses.filter(p => picked.has(p.id));
    if (new Set(chosen.map(p => p.inst)).size !== 1) { setNotice('Для одного списка отзыва выберите лицензии одной установки.'); return; }
    const done = await action.run(() => call<{ code?: string; canceled?: boolean }>('licenseRevoke', { inst: chosen[0].inst, ids: chosen.map(p => p.id) }));
    if (!done || done.value.canceled || !done.value.code) return;
    setRevocation(done.value.code); setIssued(done.value.code); setPicked(new Set());
    setNotice('Список отзыва подписан. Передайте его администратору или отправьте в общую БД.'); await reload();
  };
  const toggle = (set: Set<string>, id: string) => { const next = new Set(set); if (next.has(id)) next.delete(id); else next.add(id); return next; };

  return <div className="scroll">
    {notice && <div className="notice" role="status">{notice}</div>}
    <ErrorLine text={action.error} />
    <div className="cols">
      <section className="sect" aria-labelledby="lic-issue">
        <h3 id="lic-issue">Выпустить лицензию</h3>
        <Field label="Код запроса компании" id="lic-code"><textarea id="lic-code" rows={4} spellCheck={false} placeholder="FLUXREQ1.…" value={code} onChange={e => setCode(e.target.value)} /></Field>
        <Btn disabled={action.busy || !code.trim()} onClick={() => void read()}>Прочитать запрос</Btn>
        {parsed && <div data-testid="license-request">
          <p className="muted mono" style={{ wordBreak: 'break-all' }}>Установка: {parsed.inst}</p>
          <Field label="Компания" id="lic-company"><input id="lic-company" maxLength={200} value={company} onChange={e => setCompany(e.target.value)} /></Field>
          <div className="rows">
            <Field label="Срок" id="lic-duration"><select id="lic-duration" value={duration} onChange={e => chooseDuration(e.target.value)}>
              <option value="1">1 месяц</option><option value="3">3 месяца</option><option value="6">6 месяцев</option><option value="12">12 месяцев</option><option value="custom">Своя дата</option></select></Field>
            <Field label="До конца дня" id="lic-expiration"><input id="lic-expiration" type="date" value={expiration} onChange={e => { setExpiration(e.target.value); setDuration('custom'); }} /></Field>
          </div>
          <div className="rows"><h3 className="grow">Сотрудники {selected.size} из {parsed.people.length}</h3>
            <Btn onClick={() => setSelected(new Set(parsed.people.map(p => p.login)))}>Выбрать всех</Btn><Btn onClick={() => setSelected(new Set())}>Снять выбор</Btn></div>
          <input aria-label="Поиск сотрудника" placeholder="Поиск по логину или имени" value={filter} onChange={e => setFilter(e.target.value)} style={{ width: '100%' }} />
          <div className="people box">{people.slice(0, 200).map(p => <label key={p.login} className="person">
            <input type="checkbox" checked={selected.has(p.login)} aria-label={`Выбрать ${p.name || p.login}`} onChange={() => setSelected(toggle(selected, p.login))} />
            <span><strong>{p.name || p.login}</strong> <span className="muted">{p.login}</span></span></label>)}
            {people.length > 200 && <p className="muted">Показаны первые 200 из {people.length}. Уточните поиск. Выбор остальных сотрудников сохранён.</p>}
            {!people.length && <p className="muted">Сотрудники не найдены.</p>}</div>
          <p><Btn tone="primary" disabled={action.busy || backup || !selected.size} onClick={() => void issue()}>Выпустить ключ</Btn></p>
        </div>}
      </section>
      <section className="sect" aria-labelledby="lic-ready">
        <h3 id="lic-ready">Готовый ключ</h3>
        <p className="hint">Передайте ключ администратору компании. Его вставляют в Flux → Настройки → Лицензии.</p>
        <textarea rows={7} readOnly spellCheck={false} aria-label="Готовый ключ" placeholder="Здесь появится подписанная лицензия или список отзыва" value={issued} />
        <div className="rows" style={{ marginTop: 8 }}>
          <Btn tone="primary" disabled={!issued || action.busy} onClick={() => void copy(issued, 'Код скопирован.')}>Скопировать</Btn>
          {revocation && <Btn disabled={action.busy} onClick={async () => { if (await action.run(() => call('publishRevocation', { code: revocation }))) setNotice('Общая БД применила список отзыва.'); }}>Отправить отзыв в общую БД</Btn>}
        </div>
        <p className="hint">После окончания лицензии данные доступны для чтения. Новые изменения потребуют продления.</p>
      </section>
    </div>
    <section className="sect" aria-labelledby="lic-registry">
      <div className="rows"><h3 id="lic-registry" className="grow">Реестр выданных лицензий</h3>
        <input aria-label="Поиск лицензии" placeholder="Компания, установка, сотрудник" value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} />
        <Btn disabled={action.busy || backup || !picked.size} onClick={() => void revoke()}>Отозвать выбранные</Btn></div>
      <table className="tbl" data-testid="license-registry">
        <thead><tr><th>Выбор</th><th>Компания / установка</th><th>Сотрудники</th><th>Окончание</th><th>Ключ</th></tr></thead>
        <tbody>{rows.slice(at * PAGE, (at + 1) * PAGE).map(p => <tr key={p.id}>
          <td><input type="checkbox" checked={picked.has(p.id)} aria-label={`Выбрать лицензию ${p.id}`} onChange={() => setPicked(toggle(picked, p.id))} /></td>
          <td>{p.org || 'Компания'}<div className="muted mono">{p.inst}</div></td><td>{p.logins.join(', ')}</td>
          <td>{displayDate(p.exp)}<div>{isRevoked(p) ? <Badge tone="bad">Отозвана</Badge> : p.exp <= Date.now() ? <Badge tone="warn">Истекла</Badge> : <span className="muted">{Math.ceil((p.exp - Date.now()) / 86400000)} дн.</span>}</div></td>
          <td><span className="mono">{p.id}</span><div><Btn onClick={() => void copy(p.code, 'Ключ лицензии скопирован.')}>Копировать</Btn></div></td></tr>)}
          {!rows.length && <tr><td colSpan={5}>Выданных лицензий пока нет.</td></tr>}</tbody></table>
      <div className="rows"><Btn disabled={at === 0} onClick={() => setPage(at - 1)}>Назад</Btn>
        <span className="muted">Страница {at + 1} из {pages} · {rows.length} лицензий</span><Btn disabled={at >= pages - 1} onClick={() => setPage(at + 1)}>Далее</Btn></div>
    </section>
  </div>;
}
