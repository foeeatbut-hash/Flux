/**
 * «Программы на проверку»: всё, что владелец решает про программы разработчиков, в одном месте —
 * кто просит право публиковать, что прислано на проверку (с выпуском в том же окне), что уже выпущено
 * и кому выпуск виден. Подразделы прежние; здесь только их выбор.
 */
import React from 'react';
import Requests from './Requests';
import Releases, { Testers } from './Releases';
import Certificates from './Certificates';
import type { Section } from './types';

export const SECTIONS: Array<[Section, string]> = [
  ['certificates', 'Запросы на право публиковать'], ['requests', 'Запросы на публикацию'], ['releases', 'Выпущенные'], ['testers', 'Кому доступны'],
];
export const isSection = (value: unknown): value is Section => SECTIONS.some(([id]) => id === value);

export default function Programs({ section, onSection, counts, onRequests, onCertificates }: {
  section: Section; onSection: (s: Section) => void; counts: { requests: number; certificates: number };
  onRequests: (n: number) => void; onCertificates: (n: number) => void;
}) {
  return <div className="pane">
    <div className="segs sub" role="group" aria-label="Программы на проверку">{SECTIONS.map(([id, label]) =>
      <button key={id} type="button" aria-pressed={section === id} onClick={() => onSection(id)}>{label}
        {id === 'requests' && counts.requests > 0 && <span className="count">{counts.requests}</span>}
        {id === 'certificates' && counts.certificates > 0 && <span className="count">{counts.certificates}</span>}</button>)}</div>
    {section === 'requests' ? <Requests onCount={onRequests} />
      : section === 'releases' ? <Releases />
        : section === 'testers' ? <Testers /> : <Certificates onCount={onCertificates} />}
  </div>;
}
