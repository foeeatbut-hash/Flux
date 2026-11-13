/**
 * «Лицензии» → «Ключи и резервная копия»: открытые ключи для сборки Flux, резервная копия хранилища, смена пароля.
 * Перенесено из прежнего окна лицензий без изменения поведения; пароли в окне не сохраняются и очищаются после действия.
 */
import React, { useState } from 'react';
import { call } from './api';
import { Btn, ErrorLine, Field, useAction } from './ui';
import type { LicensesState } from './types';

const NAMES: Record<string, string> = { license: 'Подпись лицензий и отзыва', update: 'Подпись обновлений', owner: 'Вход владельца', ownerBackup: 'Запасной вход владельца' };

export default function LicenseKeys({ state }: { state: LicensesState }) {
  const [notice, setNotice] = useState('');
  const [exportPassword, setExportPassword] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const action = useAction();
  const backup = state.kind === 'backup';
  const go = async (fn: () => Promise<any>, message: string) => {
    const done = await action.run(fn);
    if (done && !done.value?.canceled) setNotice(message);
  };
  const keys = Object.entries({ ...state.publicKeys, ownerBackup: state.backupOwnerPublic }).filter(([, hex]) => hex);
  return <div className="scroll">
    {notice && <div className="notice" role="status">{notice}</div>}
    <ErrorLine text={action.error} />
    <section className="sect" aria-labelledby="keys-public">
      <h3 id="keys-public">Открытые ключи для Flux</h3>
      <ol className="hint"><li>Экспортируйте <code>flux-public-keys.json</code> и передайте сборщику Flux только этот файл.</li>
        <li>В JSON находятся открытые ключи проверки: он не позволяет выпускать лицензии, обновления или входить владельцем.</li>
        <li>Зашифрованные копии содержат закрытые ключи. Храните их отдельно и никому не отправляйте.</li></ol>
      <table className="tbl" data-testid="public-keys"><tbody>{keys.map(([purpose, hex]) => <tr key={purpose}>
        <td><strong>{NAMES[purpose] || purpose}</strong></td><td className="mono" style={{ wordBreak: 'break-all' }}>{hex}</td>
        <td><Btn disabled={action.busy} onClick={() => void go(() => call('copy', { text: hex }), 'Открытый ключ скопирован.')}>Скопировать</Btn></td></tr>)}</tbody></table>
      <div className="rows" style={{ marginTop: 8 }}>
        <Btn tone="primary" disabled={action.busy || backup} onClick={() => void go(() => call('publicExport'), 'Открытые ключи экспортированы. Передайте flux-public-keys.json сборщику Flux; файл .flux-owner оставьте у себя.')}>Экспортировать только открытые ключи</Btn>
        <Btn disabled={action.busy || backup} onClick={() => void go(() => call('publicApply'), 'Открытые ключи закреплены. Пересоберите Flux и установите первую версию вручную.')}>Вписать ключи в исходники Flux</Btn></div>
      <p className="hint">После замены ключей старые лицензии потребуется выпустить заново. Закрытые файлы в исходники и на сервер не копируют.</p>
    </section>
    <div className="cols">
      <section className="sect" aria-labelledby="keys-backup">
        <h3 id="keys-backup">Резервная копия хранилища</h3>
        <p className="hint">Резервная копия содержит закрытые ключи и реестр. Храните её отдельно от компьютера владельца, а пароль — отдельно от копии.</p>
        <Field label="Пароль экспортируемой копии" id="keys-export-password"><input id="keys-export-password" type="password" autoComplete="off" minLength={12} value={exportPassword} onChange={e => setExportPassword(e.target.value)} /></Field>
        <Btn disabled={action.busy} onClick={async () => { await go(() => call('export', { password: exportPassword }), 'Резервная копия сохранена.'); setExportPassword(''); }}>Экспортировать резервную копию</Btn>
      </section>
      <section className="sect" aria-labelledby="keys-password">
        <h3 id="keys-password">Сменить пароль хранилища</h3>
        <Field label="Новый пароль" id="keys-new"><input id="keys-new" type="password" autoComplete="off" minLength={12} value={next} onChange={e => setNext(e.target.value)} /></Field>
        <Field label="Повторите" id="keys-again"><input id="keys-again" type="password" autoComplete="off" value={again} onChange={e => setAgain(e.target.value)} /></Field>
        <Btn disabled={action.busy || state.backupSession} onClick={async () => {
          if (next !== again) { setNotice('Пароли не совпадают.'); return; }
          await go(() => call('changePassword', { password: next }), 'Пароль локального хранилища изменён.'); setNext(''); setAgain('');
        }}>Сменить пароль хранилища</Btn>
        <p className="hint">Ранее экспортированные копии продолжат использовать прежний пароль.</p>
      </section>
    </div>
  </div>;
}
