import React, { useEffect, useState } from 'react';
import { Empty, SectionHead, Status, type Tone } from '../../src/components/ui/controls';
import { REQUEST_STATES, STATE_TONE } from './call';

interface Module { moduleId: string; version: string; state: string; createdAt: string; requests: number }

/** Цвет точки состояния в словаре Flux (Status): слово всегда рядом */
export const TONE: Record<string, Tone> = { warn: 'amber', bad: 'rose', ok: 'emerald', muted: 'slate' };

/** Раздел «Подпрограммы»: свои подпрограммы, версия и состояние последней отправки */
export default function Modules() {
  const [modules, setModules] = useState<Module[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void window.studio.call<Module[]>('modules').then(reply => {
      if (!live) return;
      if (reply.ok) setModules(reply.value); else setError(reply.error);
    });
    return () => { live = false; };
  }, []);
  return (
    <section aria-label="Подпрограммы" className="fx-page">
      <SectionHead title="Подпрограммы" count={modules ? `${modules.length}` : undefined} />
      <div className="fx-page-body">
        {error && <p className="fx-error p-4" role="alert">{error}</p>}
        {modules && modules.length === 0 && (
          <Empty title="Вы ещё не отправляли подпрограмм" text="Создайте проект в разделе «Проект подпрограммы»: черновик лежит на этом компьютере, в общую базу уходит только запрос на публикацию." />
        )}
        {modules && modules.length > 0 && (
          <table className="fx-table">
            <thead><tr><th>Подпрограмма</th><th>Версия</th><th>Состояние</th><th className="text-right">Отправок</th></tr></thead>
            <tbody>{modules.map(m => (
              <tr key={m.moduleId}>
                <td className="code">{m.moduleId}</td><td className="data">{m.version}</td>
                <td><Status tone={TONE[STATE_TONE[m.state] || 'muted']}>{REQUEST_STATES[m.state] || m.state}</Status></td>
                <td className="text-right data">{m.requests}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </section>
  );
}
