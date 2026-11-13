/**
 * «Лицензии» → «Выпуск Flux»: подпись и публикация нового выпуска Flux для сотрудников и реестр подписанных выпусков.
 * Перенесено из прежнего окна лицензий (вкладка «Обновления») без изменения поведения. Назначение выпуска компьютерам — в «Flux: обновления».
 */
import React, { useState } from 'react';
import { call } from './api';
import { Btn, ErrorLine, Field, useAction } from './ui';
import { displayDate } from './useLicenses';
import type { LicensesState } from './types';

export default function FluxPublish({ state, reload }: { state: LicensesState; reload: () => Promise<void> }) {
  const [version, setVersion] = useState('');
  const [changelog, setChangelog] = useState('');
  const [notice, setNotice] = useState('');
  const action = useAction();
  const backup = state.kind === 'backup';
  const go = async (fn: () => Promise<any>, message: string) => {
    const done = await action.run(fn);
    if (done && !done.value?.canceled) { setNotice(message); await reload(); }
  };
  const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
  return <div className="scroll">
    {notice && <div className="notice" role="status">{notice}</div>}
    <ErrorLine text={action.error} />
    <div className="cols">
      <section className="sect" aria-labelledby="pub-new">
        <h3 id="pub-new">Выпуск для сотрудников</h3>
        <p className="hint">Выберите portable EXE. Отпечаток считается потоком, окно остаётся доступным. Удалённый файл по ссылке не используется.</p>
        <Btn disabled={action.busy || backup} onClick={() => void go(() => call('chooseExe'), 'EXE проверен. Введите версию и описание изменений.')}>Выбрать EXE</Btn>
        <pre className="box mono" data-testid="exe-details" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{state.exe ? `${state.exe.name}\n${mb(state.exe.size)} МБ\nSHA-256: ${state.exe.sha256}` : 'Файл не выбран'}</pre>
        <Field label="Версия" id="pub-version"><input id="pub-version" placeholder="1.18.2" maxLength={80} value={version} onChange={e => setVersion(e.target.value)} /></Field>
        <Field label="Что изменилось для сотрудников" id="pub-changelog"><textarea id="pub-changelog" rows={6} maxLength={20000} placeholder="Коротко опишите изменения и важные условия обновления" value={changelog} onChange={e => setChangelog(e.target.value)} /></Field>
        <Btn tone="primary" disabled={action.busy || backup || !state.connected || !state.exe} onClick={() => void go(() => call('publish', { version: version.trim(), changelog }), 'Обновление опубликовано через БД.')}>Подписать и опубликовать</Btn>
        <p className="hint">Flux автоматически подписывает EXE перед публикацией. Перед отправкой появится проверка общей БД, версии и файла. Публикация требует подключения к общей базе.</p>
        <details><summary>Сохранить подпись без публикации</summary>
          <p className="hint">Используйте этот способ, если выпускаете обновления вне подключённой общей БД.</p>
          <Btn disabled={action.busy || backup || !state.exe} onClick={() => void go(() => call('signUpdate', { version: version.trim() }), 'Подпись сохранена.')}>Сохранить подпись .flux-sig</Btn></details>
      </section>
      <section className="sect" aria-labelledby="pub-registry">
        <h3 id="pub-registry">Реестр выпусков</h3>
        <div data-testid="update-registry">{state.updates.slice().reverse().slice(0, 50).map(p => <div key={p.version + p.iat} className="box">
          <strong>{p.version} · {p.published ? 'Опубликована' : 'Подписана'}</strong>
          <p className="muted">{displayDate(p.iat)} · {p.name} · {mb(p.size)} МБ</p>
          <div className="rows"><Btn disabled={action.busy} onClick={() => void go(() => call('copy', { text: p.signature }), 'Подпись скопирована.')}>Копировать подпись</Btn>
            {p.published && <Btn disabled={action.busy || !state.connected || state.server !== p.server} onClick={() => void go(() => call('withdrawUpdate', { version: p.version }), 'Выпуск отозван в общей БД.')}>Отозвать выпуск</Btn>}</div></div>)}
          {!state.updates.length && <p className="muted">Подписанных выпусков пока нет.</p>}</div>
        <p className="hint">Отзыв останавливает новые скачивания. Уже установленная версия не удаляется с компьютеров сотрудников.</p>
      </section>
    </div>
  </div>;
}
