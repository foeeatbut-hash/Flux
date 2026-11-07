import React, { useState } from 'react';
import { Btn, Dialog, Field, Input } from '../ui';

/**
 * Диалог решения владельца, которое требует его подписи: выпуск, правка,
 * отзыв, сертификат. Фраза-пароль хранилища уходит только в главный процесс
 * (`modules:sign`), файл хранилища он спрашивает сам.
 */
export default function OwnerSignDialog({ title, action, children, onClose, onSign, danger }: {
  title: string; action: string; children?: React.ReactNode; danger?: boolean;
  onClose: () => void;
  /** Подписать и отправить; вернуть текст ошибки или '' */
  onSign: (password: string) => Promise<string>;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    setBusy(true); setError('');
    try {
      const why = await onSign(password);
      if (why) setError(why); else onClose();
    } catch (e: any) { setError(e?.message || 'Не выполнено'); }
    finally { setBusy(false); setPassword(''); }
  };
  return <Dialog title={title} onClose={() => !busy && onClose()} busy={busy} width="max-w-lg"
    footer={<><Btn disabled={busy} onClick={onClose}>Отмена</Btn>
      <Btn tone={danger ? 'danger' : 'primary'} disabled={busy || password.length < 12} onClick={() => void run()}>{action}</Btn></>}>
    <div className="flex flex-col gap-3">
      {children}
      <Field label="Фраза-пароль хранилища владельца" hint="Файл хранилища Flux спросит после нажатия. Ключ не покидает этот компьютер.">
        <Input type="password" value={password} autoComplete="off" onChange={(e) => setPassword(e.target.value)} />
      </Field>
      {error && <div className="fx-error">{error}</div>}
    </div>
  </Dialog>;
}
