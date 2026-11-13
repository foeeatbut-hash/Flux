/**
 * Хранилище владельца: вход паролем, создание новых ключей (три шага: пароль и папка копий → проверка → готово),
 * вход запасным ключом и восстановление из копии. Перенесено из прежнего окна лицензий без изменения поведения;
 * пароли живут только в полях этой формы и очищаются после действия.
 */
import React, { useState } from 'react';
import { call } from './api';
import { Btn, ErrorLine, Field, useAction } from './ui';
import type { LicensesState, Snapshot } from './types';

export type Wizard = '' | 'edit' | 'verify' | 'complete';
const MIN = 12;

function Password({ id, label, value, onChange, autoComplete }: { id: string; label: string; value: string; onChange: (v: string) => void; autoComplete: string }) {
  const [shown, setShown] = useState(false);
  const [caps, setCaps] = useState(false);
  return <Field label={label} id={id} hint={caps ? 'Включён Caps Lock. Проверьте регистр букв.' : undefined}>
    <div className="rows"><input id={id} type={shown ? 'text' : 'password'} autoComplete={autoComplete} value={value} minLength={MIN} className="grow"
      onChange={e => onChange(e.target.value)} onKeyUp={e => setCaps(e.getModifierState('CapsLock'))} onBlur={() => setCaps(false)} />
      <Btn aria-pressed={shown} aria-label={shown ? `Скрыть: ${label}` : `Показать: ${label}`} onClick={() => setShown(!shown)}>{shown ? 'Скрыть' : 'Показать'}</Btn></div></Field>;
}

export default function VaultGate({ state, wizard, onWizard, onState }: {
  state: Snapshot; wizard: Wizard; onWizard: (w: Wizard) => void; onState: (s: Snapshot) => void;
}) {
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState({ password: '', confirm: '' });
  const [folder, setFolder] = useState('');
  const [verify, setVerify] = useState('');
  const [backup, setBackup] = useState('');
  const [restore, setRestore] = useState({ from: '', password: '', again: '' });
  const [kit, setKit] = useState<LicensesState | null>(null);
  const { busy, error, setError, run } = useAction();
  const fail = (text: string) => { setError(text); return undefined; };

  const refreshKit = async () => setKit(await call<LicensesState>('licensesState'));
  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    const done = await run(() => call<Snapshot>('unlock', { password }));
    setPassword('');
    if (!done) return;
    onState(done.value);
    // Комплект создан, но не проверен повторным вводом пароля: вход ведёт на проверку
    const full = await call<LicensesState>('licensesState'); setKit(full);
    if (full.setupKitPath && !full.setupVerified) onWizard('verify');
  };
  const chooseFolder = async () => {
    const done = await run(() => call<{ canceled?: boolean; folderPath?: string }>('chooseSetupFolder'));
    if (done && !done.value.canceled) setFolder(done.value.folderPath || 'Папка выбрана');
  };
  const create = async () => {
    if (!folder) return fail('Сначала выберите папку для комплекта резервных копий.');
    if (setup.password.length < MIN) return fail('Пароль должен содержать не менее 12 символов.');
    if (setup.password !== setup.confirm) return fail('Пароли при повторном вводе не совпадают.');
    const done = await run(() => call<any>('setup', { password: setup.password, confirmPassword: setup.confirm, replaceExisting: !!state.vaultExists }));
    setSetup({ password: '', confirm: '' });
    if (done && !done.value.canceled) { onState(await call<Snapshot>('state')); await refreshKit(); onWizard('verify'); }
  };
  const check = async () => {
    if (!verify) return fail('Введите пароль для проверки созданных файлов.');
    const done = await run(() => call<LicensesState>('verifySetup', { password: verify }));
    setVerify('');
    if (done?.value.setupVerified) { setKit(done.value); onWizard('complete'); }
  };
  const openBackup = async () => {
    const done = await run(() => call<any>('openBackup', { password: backup }));
    setBackup('');
    if (done && !done.value.canceled) onState(await call<Snapshot>('state'));
  };
  const importCopy = async () => {
    if (restore.password.length < MIN || restore.password !== restore.again) return fail('Повторите новый пароль: значения должны совпадать и содержать не менее 12 символов.');
    const done = await run(() => call<any>('import', { importPassword: restore.from, password: restore.password }));
    setRestore({ from: '', password: '', again: '' });
    if (done && !done.value.canceled) { onState(await call<Snapshot>('state')); onWizard(''); }
  };
  const folderHint = state.vaultExists ? 'Прежнее хранилище сохранится отдельно; рабочий файл получит новые ключи. Старые лицензии подписаны прежними ключами и после замены не подойдут: их потребуется выпустить заново.' : '';

  if (wizard === 'edit') {
    return <form className="card" aria-labelledby="gate-title" onSubmit={e => { e.preventDefault(); void create(); }}>
      <h2 id="gate-title">Создайте хранилище владельца</h2>
      <p className="muted">Задайте один пароль и выберите папку для резервных копий.</p>
      {folderHint && <p className="muted" role="note">{folderHint}</p>}
      <Password id="setup-password" label="Общий пароль хранилища и резервных копий" value={setup.password} onChange={v => setSetup({ ...setup, password: v })} autoComplete="new-password" />
      <Password id="setup-confirm" label="Повторите пароль" value={setup.confirm} onChange={v => setSetup({ ...setup, confirm: v })} autoComplete="new-password" />
      <p className="hint">Не менее 12 символов. Этот пароль защищает хранилище и обе копии текущего комплекта.</p>
      <div className="rows"><Btn disabled={busy} onClick={() => void chooseFolder()}>Выбрать папку для копий</Btn><span className="muted" title={folder}>{folder || 'Папка не выбрана'}</span></div>
      <ErrorLine text={error} />
      <div className="rows" style={{ marginTop: 12 }}><Btn type="submit" tone="primary" disabled={busy || !folder}>Создать ключи</Btn>
        <Btn disabled={busy} onClick={() => { setSetup({ password: '', confirm: '' }); setError(''); onWizard(''); }}>Назад</Btn></div>
    </form>;
  }
  if (wizard === 'verify') {
    return <form className="card" aria-labelledby="gate-title" onSubmit={e => { e.preventDefault(); void check(); }}>
      <h2 id="gate-title">Проверьте созданное хранилище</h2>
      <p className="muted">Введите пароль ещё раз. Studio расшифрует основное хранилище и все копии, прежде чем показать результат.</p>
      <Password id="verify-password" label="Пароль хранилища" value={verify} onChange={setVerify} autoComplete="current-password" />
      <ErrorLine text={error} />
      <Btn type="submit" tone="primary" disabled={busy}>Проверить и продолжить</Btn>
    </form>;
  }
  if (wizard === 'complete') {
    return <section className="card" aria-labelledby="gate-title">
      <h2 id="gate-title">Хранилище готово</h2>
      <p className="muted">Передайте сборщику только <code>flux-public-keys.json</code>. Резервные копии содержат закрытые ключи: храните их отдельно и никому не отправляйте.</p>
      {kit?.previousVaultPath && <p className="muted" style={{ wordBreak: 'break-all' }}>Старая копия хранилища сохранена: {kit.previousVaultPath}</p>}
      <p className="muted" style={{ wordBreak: 'break-all' }}>Комплект настройки: {kit?.setupKitPath}</p>
      <ErrorLine text={error} />
      <div className="rows"><Btn disabled={busy} onClick={() => void run(() => call('showSetupFolder'))}>Открыть папку</Btn>
        <Btn disabled={busy} onClick={() => void run(() => call('publicExport'))}>Экспортировать JSON</Btn>
        <Btn tone="primary" onClick={() => onWizard('')}>Перейти к разделам владельца</Btn></div>
    </section>;
  }
  return <form className="card" onSubmit={unlock} aria-labelledby="gate-title">
    <h2 id="gate-title">Хранилище владельца</h2>
    {state.vaultExists
      ? <><p className="muted">Подписи выпусков, сертификатов, лицензий и обновлений ставятся ключами из вашего хранилища. Ключи остаются на этом компьютере.</p>
        <Password id="vault-password" label="Пароль хранилища" value={password} onChange={setPassword} autoComplete="current-password" />
        <ErrorLine text={error} />
        <div className="rows"><Btn type="submit" tone="primary" disabled={busy || password.length < MIN}>{busy ? 'Открываем…' : 'Открыть хранилище'}</Btn>
          <Btn disabled={busy} onClick={() => { setError(''); onWizard('edit'); }}>Создать новые ключи</Btn></div></>
      : <><p className="muted">Хранилища ключей на этом компьютере нет. Закрытые ключи остаются на этом компьютере.</p>
        <ErrorLine text={error} />
        <Btn tone="primary" disabled={busy} onClick={() => { setError(''); onWizard('edit'); }}>Создать хранилище</Btn></>}
    <details className="stage"><summary>Другие способы входа и восстановления</summary>
      <Password id="backup-password" label="Вход аварийным запасным ключом" value={backup} onChange={setBackup} autoComplete="off" />
      <p className="hint">Временный вход этим ключом нужен для подключения владельцем. Он не открывает полное хранилище и не позволяет подписывать лицензии и обновления.</p>
      <Btn disabled={busy} onClick={() => void openBackup()}>Войти запасным ключом</Btn>
      <h3 style={{ marginTop: 16 }}>Восстановление полного хранилища из резервной копии</h3>
      <p className="hint">Это заменит хранилище на этом компьютере содержимым выбранной копии.</p>
      <Password id="restore-from" label="Пароль выбранной копии" value={restore.from} onChange={v => setRestore({ ...restore, from: v })} autoComplete="off" />
      <Password id="restore-new" label="Новый пароль для этого компьютера" value={restore.password} onChange={v => setRestore({ ...restore, password: v })} autoComplete="new-password" />
      <Password id="restore-again" label="Повторите новый пароль" value={restore.again} onChange={v => setRestore({ ...restore, again: v })} autoComplete="new-password" />
      <Btn disabled={busy} onClick={() => void importCopy()}>Выбрать копию и восстановить</Btn>
    </details>
  </form>;
}
