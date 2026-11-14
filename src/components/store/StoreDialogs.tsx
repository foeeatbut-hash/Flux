/**
 * Окна Store: разрешения при установке и обновлении, удаление.
 */
import React, { useState } from 'react';
import { Btn, Dialog } from '../ui';
import './store.css';
import { categoryName, formatSize, storeInfoOf, type StoreListing } from '../../../modules/store/model';
import { DEV_BADGE, type DevRunItem } from '../../../modules/store/devRun';
import { OFFLINE_HINT, STORAGE_DELETE_NOTICE, WORKS_OFFLINE_LABEL, isStandalone, worksOffline } from '../../../modules/storage/model';
import { devPermissions } from '../../services/moduleDevRunActions';
import { installPlan, installModule, newPermissions, removeModule, updateModule } from '../../services/moduleStoreActions';
import { ModuleIcon } from './StoreParts';

export type StoreDialog = null | { kind: 'install' | 'update' | 'remove'; listing: StoreListing };

export function RequirementsList({ listing }: { listing: StoreListing }) {
  const r = listing.requires;
  const rows: string[] = [
    `Минимальная версия Flux: ${r.flux || 'любая'}`,
    `Платформа: ${r.platform === 'windows' ? 'Windows' : 'любая'}`,
    `Договор программ: v${listing.manifest.contractVersion}`,
    ...(r.external?.length ? [`Нужны программы: ${r.external.join(', ')}`] : []),
    `Размер: ${formatSize(listing.size)}`,
  ];
  return <>{rows.map((t) => <div key={t} className="stx-perm">{t}</div>)}</>;
}

export function PermissionsList({ listing, added = [] }: { listing: Pick<StoreListing, 'permissions'>; added?: string[] }) {
  // Заметные разрешения (любой адрес в интернете, локальная сеть) выделены рамкой: их нельзя принять не заметив
  return <>{listing.permissions.map((p) => <div key={p.text} data-notable={p.notable ? '' : undefined} className={`stx-perm${added.includes(p.text) ? ' is-new' : ''}${p.notable ? ' is-notable' : ''}`}>
    <span aria-hidden="true">{p.kind === 'write' || p.kind === 'run' ? '✕' : p.kind === 'open' ? '↗' : p.notable ? '!' : '●'}</span>
    <span>{p.text}{added.includes(p.text) ? ' — новое в этой версии' : ''}</span>
  </div>)}</>;
}

export default function StoreDialogs({ dialog, onClose, onDone }: { dialog: StoreDialog; onClose: () => void; onDone?: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [wipe, setWipe] = useState(false);
  if (!dialog) return null;
  const { kind, listing } = dialog;
  const run = async () => {
    setBusy(true); setError('');
    try {
      if (kind === 'install') await installModule(listing);
      else if (kind === 'update') await updateModule(listing);
      else await removeModule(listing, !wipe);
      onDone?.(kind === 'remove' ? `«${listing.name}» удалена` : `«${listing.name}» ${listing.version} готова`);
      onClose();
    } catch (e: any) { setError(e?.message || 'Не выполнено'); } finally { setBusy(false); }
  };

  if (kind === 'remove') {
    return <Dialog title={`Удалить «${listing.name}»?`} onClose={onClose} busy={busy} footer={<><Btn disabled={busy} onClick={onClose}>Отмена</Btn>
      <Btn tone="danger" disabled={busy} onClick={() => void run()}>Удалить</Btn></>}>
      <div className="flex flex-col gap-3 text-sm">
        <div>Программа пропадёт из «Пуска» и карточек только у вас. Поставить её снова можно из Store.</div>
        {isStandalone(listing.manifest) && <div className="stx-note" data-testid="stx-delete-data">{STORAGE_DELETE_NOTICE}</div>}
        <label className="flex items-center gap-2"><input type="checkbox" checked={wipe} onChange={(e) => setWipe(e.target.checked)} />
          Удалить и данные программы (по умолчанию они сохраняются на случай повторной установки)</label>
        {error && <div className="fx-error">{error}</div>}
      </div>
    </Dialog>;
  }

  const plan = kind === 'install' ? installPlan(listing) : [];
  const deps = plan.filter((p) => p.listing.moduleId !== listing.moduleId);
  const added = kind === 'update' ? newPermissions(listing) : [];
  return <Dialog title={kind === 'install' ? `Установить «${listing.name}»` : `Обновить «${listing.name}» до ${listing.version}`} onClose={onClose} busy={busy} width="max-w-lg"
    footer={<><Btn disabled={busy} onClick={onClose}>Отмена</Btn><Btn tone="primary" disabled={busy} onClick={() => void run()}>{kind === 'install' ? 'Установить' : 'Принять и обновить'}</Btn></>}>
    <div className="flex flex-col gap-3" data-testid="stx-dialog">
      <div className="flex items-center gap-3"><ModuleIcon listing={listing} size={48} />
        <div className="min-w-0"><div className="font-semibold">{listing.name} {listing.version}</div>
          <div className="text-xs" style={{ color: 'var(--flux-text-muted)' }}>{listing.developer} · {categoryName(listing.category)}</div></div></div>
      {deps.length > 0 && <div className="stx-note">Вместе с ней поставится: {deps.map((d) => `${d.listing.name} ${d.version}`).join(', ')}</div>}
      {added.length > 0 && <div className="stx-note">Новая версия просит больше, чем прежняя. Проверьте разрешения ниже.</div>}
      <div><div className="mb-1 text-sm font-semibold">Программа получит</div><PermissionsList listing={listing} added={added} /></div>
      {worksOffline(listing.manifest) && <div className="stx-note" data-testid="stx-offline"><b>{WORKS_OFFLINE_LABEL}.</b> {OFFLINE_HINT}</div>}
      <div><div className="mb-1 text-sm font-semibold">Требования</div><RequirementsList listing={listing} /></div>
      {kind === 'install' && listing.testing && <div className="stx-note">Это тестовая версия: её видят только назначенные владельцем тестировщики.</div>}
      {busy && <div className="text-sm" style={{ color: 'var(--flux-text-muted)' }}>Скачивание и проверка подписи владельца…</div>}
      {error && <div className="fx-error">{error}</div>}
    </div>
  </Dialog>;
}

/**
 * Первый запуск программы из разработки: те же разрешения, что при установке из Store, но про непроверенную сборку.
 * Согласие действует на эту сборку и этого человека, пока открыт Flux; новая сборка спросит снова.
 */
export function DevConsentDialog({ item, onClose, onAccept }: { item: DevRunItem; onClose: () => void; onAccept: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const accept = async () => {
    setBusy(true); setError('');
    try { await onAccept(); } catch (e: any) { setError(e?.message || 'Не выполнено'); } finally { setBusy(false); }
  };
  return <Dialog title={`Запустить «${item.name}» из разработки`} onClose={onClose} busy={busy} width="max-w-lg"
    footer={<><Btn disabled={busy} onClick={onClose}>Отмена</Btn><Btn tone="primary" disabled={busy} onClick={() => void accept()}>Принять и запустить</Btn></>}>
    <div className="flex flex-col gap-3" data-testid="dev-consent">
      <div className="flex items-center gap-3"><ModuleIcon listing={{ name: item.name, color: storeInfoOf(item.manifest!).color }} size={48} />
        <div className="min-w-0"><div className="font-semibold">{item.name} {item.version}</div>
          <div className="text-xs" style={{ color: 'var(--flux-text-muted)' }}>{item.developer || 'Разработчик'} · {DEV_BADGE}</div></div></div>
      <div className="stx-note">Эту сборку ещё не проверял и не подписывал владелец. Она запускается только у вас, на этом компьютере и пока открыта Studio, а данные Flux может только читать, как любая программа.</div>
      <div><div className="mb-1 text-sm font-semibold">Программа получит</div><PermissionsList listing={{ permissions: devPermissions(item) }} /></div>
      {busy && <div className="text-sm" style={{ color: 'var(--flux-text-muted)' }}>Проверка в главном процессе…</div>}
      {error && <div className="fx-error">{error}</div>}
    </div>
  </Dialog>;
}
