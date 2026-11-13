/**
 * Библиотека: «Из разработки» — программы, которые Studio передала Flux («Запустить во Flux»).
 *
 * Видны только их разработчику. Не прошедшие проверку остаются в списке с причиной словами, чтобы было понятно,
 * почему программа не открывается; «Убрать» останавливает программу и удаляет папку обмена.
 */
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { storeInfoOf } from '../../../modules/store/model';
import { moduleHref } from '../../../modules/launch';
import { Chip } from '../ui';
import { useModuleStore } from '../../store/moduleStoreState';
import { acceptDevRun, DEV_BADGE, removeDevRun } from '../../services/moduleDevRunActions';
import { ModuleIcon } from './StoreParts';
import { DevConsentDialog } from './StoreDialogs';

export default function StoreDevRuns() {
  const navigate = useNavigate();
  const items = useModuleStore((s) => s.local?.dev) || [];
  const [consent, setConsent] = useState('');
  const [message, setMessage] = useState('');
  if (!items.length) return null;
  const run = async (fn: () => Promise<unknown>) => { setMessage(''); try { await fn(); } catch (e: any) { setMessage(e?.message || 'Не выполнено'); } };
  const asked = items.find((d) => d.moduleId === consent && d.live && d.manifest);
  return <div data-testid="stx-dev" className="grid gap-2">
    <div className="stx-h" style={{ fontSize: 16 }}>Из разработки</div>
    {message && <div className="fx-error">{message}</div>}
    {items.map((d) => <div key={d.moduleId} className="stx-card" style={{ cursor: 'default' }} data-testid={`stx-dev-${d.moduleId}`}>
      <ModuleIcon listing={{ name: d.name, color: d.manifest ? storeInfoOf(d.manifest).color : '#64748b' }} size={48} />
      <div className="stx-card-body">
        <div className="stx-card-name">{d.name}{d.version ? ` ${d.version}` : ''}</div>
        <div className="stx-card-sub" style={{ whiteSpace: 'normal' }}>{d.live ? `${d.developer || 'Разработчик'} · только у вас, пока открыта Studio` : d.why}</div>
      </div>
      <Chip tone={d.live ? 'amber' : 'rose'} title={d.live ? 'Сборку не проверял и не подписывал владелец' : d.why}>{d.live ? DEV_BADGE : 'Не запускается'}</Chip>
      {d.live && (d.accepted
        ? <button type="button" className="stx-act" data-kind="open" onClick={() => navigate(moduleHref(d.moduleId))}>Открыть</button>
        : <button type="button" className="stx-act" onClick={() => setConsent(d.moduleId)}>Запустить</button>)}
      <button type="button" className="fx-btn" onClick={() => void run(() => removeDevRun(d.moduleId))}>Убрать</button>
    </div>)}
    {asked && <DevConsentDialog item={asked} onClose={() => setConsent('')}
      onAccept={async () => { await acceptDevRun(asked); setConsent(''); navigate(moduleHref(asked.moduleId)); }} />}
  </div>;
}
