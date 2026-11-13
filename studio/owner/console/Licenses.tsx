/**
 * «Лицензии»: выпуск и отзыв лицензий компаниям, выпуск Flux, открытые ключи и резервная копия хранилища. Это бывшее окно лицензий
 * (Flux Owner), теперь раздел окна Studio — Владелец: хранилище и подключение общие, пароль второй раз не спрашивается.
 */
import React from 'react';
import { ErrorLine } from './ui';
import LicenseIssue from './LicenseIssue';
import FluxPublish from './FluxPublish';
import LicenseKeys from './LicenseKeys';
import { useLicenses } from './useLicenses';
import type { LicenseSection } from './types';

export const LICENSE_SECTIONS: Array<[LicenseSection, string]> = [['licenses', 'Лицензии компаний'], ['publish', 'Выпуск Flux'], ['keys', 'Ключи и резервная копия']];

export default function Licenses({ section, onSection }: { section: LicenseSection; onSection: (s: LicenseSection) => void }) {
  const { state, error, reload } = useLicenses();
  return <div className="pane">
    <div className="segs sub" role="group" aria-label="Лицензии">{LICENSE_SECTIONS.map(([id, label]) =>
      <button key={id} type="button" aria-pressed={section === id} onClick={() => onSection(id)}>{label}</button>)}</div>
    <ErrorLine text={error} />
    {state && (section === 'licenses' ? <LicenseIssue state={state} reload={reload} /> : section === 'publish' ? <FluxPublish state={state} reload={reload} /> : <LicenseKeys state={state} />)}
  </div>;
}
