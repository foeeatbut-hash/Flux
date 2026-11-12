/**
 * «Лицензии»: выпуск и отзыв лицензий компаниям, открытые ключи, резервная копия хранилища. Это прежнее окно
 * лицензий (оно не переписывалось); здесь оно открывается одной кнопкой, а хранилище и подключение у обоих окон общие.
 */
import React from 'react';
import { call } from './api';
import { Btn, Empty, ErrorLine, useAction } from './ui';

export default function Licenses() {
  const { busy, error, run } = useAction();
  return <div className="scroll"><div className="pad" style={{ textAlign: 'center' }}>
    <Empty title="Лицензии компаний" text="Выпуск и отзыв лицензий, реестр выданных, открытые ключи и резервная копия хранилища. Окно откроется отдельно; пароль хранилища второй раз не спрашивается." />
    <Btn tone="primary" disabled={busy} onClick={() => void run(() => call('openLicenses', { tab: 'licenses' }))}>Открыть лицензии</Btn>
    <ErrorLine text={error} />
  </div></div>;
}
