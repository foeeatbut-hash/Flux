/**
 * «Лицензии»: выпуск и отзыв лицензий компаниям, открытые ключи, резервная копия хранилища. Это прежнее окно
 * лицензий (оно не переписывалось); здесь оно открывается одной кнопкой, а хранилище и подключение у обоих окон общие.
 */
import React from 'react';
import { call } from './api';
import { Btn, Empty, ErrorLine, useAction } from './ui';

export default function Licenses() {
  const { busy, error, run } = useAction();
  return <div className="scroll" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: 24 }}>
    <Empty title="Лицензии компаний" text="Выпуск и отзыв лицензий, реестр выданных, открытые ключи и резервная копия хранилища. Окно откроется отдельно; пароль хранилища второй раз не спрашивается." />
    <div><Btn tone="primary" disabled={busy} onClick={() => void run(() => call('openLicenses', { tab: 'licenses' }))}>Открыть лицензии</Btn></div>
    <ErrorLine text={error} />
  </div>;
}
