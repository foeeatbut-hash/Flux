/**
 * Скрытый раздел «Экстренная установка»: открывается сочетанием CapsLock + Shift + Ctrl, нигде не показан.
 *
 * Для случая, когда выпущено неудачное обновление и обновления через базу больше не работают: владелец передаёт
 * файл .fluxupdate любым способом, сотрудник выбирает его здесь. Раздел стоит ВНЕ экрана входа, лицензии и
 * заставки сервера и ни к чему из них не обращается: работает, даже если вход или сервер сломаны. Проверку
 * подписи, размера и SHA-256 делает главный процесс (electron/emergencyInstall.ts); здесь только показ.
 */
import React from 'react';
import { Dialog, Btn } from './ui';
import { watchEmergencyChord } from '../lib/emergencyChord';

type Bridge = {
  pick: () => Promise<{ ok: boolean; canceled?: boolean; error?: string; version?: string; current?: string; name?: string; sizeMb?: number }>;
  install: () => Promise<{ ok: boolean; started?: boolean; deferred?: boolean; error?: string }>;
  discard: () => Promise<unknown>;
  onProgress: (fn: (percent: number) => void) => () => void;
};
type Picked = { version: string; current: string; name: string; sizeMb: number };

const bridge = (): Bridge | null => (window as any).electron?.emergencyUpdate ?? null;

export default function EmergencyUpdate() {
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => watchEmergencyChord(window, () => setOpen(true)), []);
  return open ? <EmergencyDialog onClose={() => setOpen(false)} /> : null;
}

function EmergencyDialog({ onClose }: { onClose: () => void }) {
  const api = bridge();
  const [busy, setBusy] = React.useState<'' | 'checking' | 'installing'>('');
  const [percent, setPercent] = React.useState(0);
  const [picked, setPicked] = React.useState<Picked | null>(null);
  const [error, setError] = React.useState('');
  const [started, setStarted] = React.useState(false);

  React.useEffect(() => api?.onProgress(setPercent), [api]);
  // Закрытие окна убирает подготовленный файл из временной папки
  const close = () => { void api?.discard(); onClose(); };

  const pick = async () => {
    if (!api) return;
    setBusy('checking'); setError(''); setPicked(null); setPercent(0);
    try {
      const r = await api.pick();
      if (r.ok && r.version) setPicked({ version: r.version, current: r.current || '', name: r.name || '', sizeMb: r.sizeMb || 0 });
      else if (!r.canceled) setError(r.error || 'Пакет не принят.');
    } catch (e: any) { setError(e?.message || 'Не удалось проверить пакет.'); }
    finally { setBusy(''); }
  };
  const install = async () => {
    if (!api || !picked) return;
    setBusy('installing'); setError('');
    try {
      const r = await api.install();
      if (r.ok) setStarted(true);
      else { setError(r.error || 'Не удалось начать установку.'); if (!r.deferred) setPicked(null); }
    } catch (e: any) { setError(e?.message || 'Не удалось начать установку.'); }
    finally { setBusy(''); }
  };

  return (
    <Dialog
      title="Экстренная установка"
      onClose={close}
      busy={busy === 'installing' || started}
      label="Экстренная установка из файла"
      footer={<>
        <Btn onClick={close} disabled={busy === 'installing' || started}>Закрыть</Btn>
        {picked && !started && <Btn tone="primary" onClick={() => void install()} disabled={!!busy}>Установить и перезапустить</Btn>}
      </>}
    >
      <div className="flex flex-col gap-3" data-testid="emergency-update">
        <p>Для случая, когда обновление через базу не работает. Выберите файл <span className="font-mono">.fluxupdate</span>, который передал владелец программы. Подпись проверяется здесь, без сервера и без входа.</p>
        {!api && <p className="fx-error" role="alert">Раздел работает только в программе Flux для Windows.</p>}
        {api && !picked && !started && (
          <div>
            <Btn onClick={() => void pick()} disabled={!!busy}>{busy === 'checking' ? 'Проверяем…' : 'Выбрать файл'}</Btn>
          </div>
        )}
        {busy === 'checking' && (
          <div className="fx-hint" role="status" aria-live="polite" data-testid="emergency-progress">Проверяем подпись и содержимое файла: {percent}%</div>
        )}
        {picked && !started && (
          <div role="status" data-testid="emergency-ready" className="flex flex-col gap-1">
            <div className="text-slate-900 dark:text-slate-100">Пакет проверен: подпись владельца верна</div>
            <div className="fx-hint">Версия {picked.version} (сейчас {picked.current}) · {picked.sizeMb.toLocaleString('ru-RU')} МБ · {picked.name}</div>
            <div className="fx-hint">Перед установкой сохраните всё нужное: программа закроется и откроется заново уже новой версией.</div>
          </div>
        )}
        {started && <div role="status" className="text-slate-900 dark:text-slate-100" data-testid="emergency-started">Запускаю установку. Программа закроется и откроется заново.</div>}
        {error && <p className="fx-error" role="alert" data-testid="emergency-error">{error}</p>}
      </div>
    </Dialog>
  );
}
