/**
 * «Вернуть предыдущую версию всем» — на случай неудачного обновления (ответ владельца 15 ноября 2026: «Да»).
 *
 * Возврат — обязательное обновление на предыдущий выпуск; новый выпуск не создаётся. Диалог говорит, что
 * произойдёт и у кого, до подписи. Расчёт тот же, что делает главный процесс, и он пересчитает его по
 * свежему списку сам (studio/owner/src/rollbackPlan.ts).
 */
import React, { useState } from 'react';
import { rollbackPlan } from '../src/rollbackPlan';
import { call } from './api';
import { Btn, Dialog, ErrorLine, useAction } from './ui';
import type { UpdateDevice, UpdateRelease } from './types';

export default function UpdateRollback({ onDone }: { onDone: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [minutes, setMinutes] = useState('10');
  const [data, setData] = useState<{ devices: UpdateDevice[]; releases: UpdateRelease[] } | null>(null);
  const action = useAction();
  const delay = Number(minutes), valid = Number.isInteger(delay) && delay >= 5 && delay <= 1440;
  const plan = data ? rollbackPlan(data.devices, data.releases) : null;

  const show = async () => {
    setOpen(true); setData(null);
    const loaded = await action.run(() => call<{ devices: UpdateDevice[]; releases: UpdateRelease[] }>('devices'));
    if (loaded) setData(loaded.value);
  };
  const run = async () => {
    const done = await action.run(() => call<{ version: string; devices: number }>('rollbackAll', { minutes: delay }));
    if (done) { setOpen(false); onDone(`Возврат на версию ${done.value.version} назначен: ${done.value.devices} комп.`); }
  };

  return <>
    <Btn tone="danger" onClick={() => void show()} title="Назначить всем обязательное обновление на предыдущую версию Flux">Вернуть предыдущую версию всем…</Btn>
    {open && <Dialog title="Вернуть предыдущую версию всем" onClose={() => !action.busy && setOpen(false)} busy={action.busy}
      footer={<><Btn disabled={action.busy} onClick={() => setOpen(false)}>Отмена</Btn>
        <Btn tone="danger" disabled={action.busy || !plan || 'error' in plan || !valid} onClick={() => void run()}>{plan && !('error' in plan) ? `Вернуть версию ${plan.release.version} всем` : 'Вернуть версию'}</Btn></>}>
      {!plan ? <p className="muted">Загрузка списка компьютеров…</p>
        : 'error' in plan ? <p>{plan.error}</p>
          : <>
            <p>Сейчас у сотрудников стоит до версии <b>{plan.top}</b>. Вернётся версия <b>{plan.release.version}</b>.</p>
            <ul>
              <li>Затронуто: {plan.people} чел., компьютеров: {plan.targets.length}.</li>
              <li>Это обязательное обновление: отложить его нельзя. Перед заменой Flux просит сохранить документы.</li>
              <li>Новый выпуск не создаётся. Версия {plan.top} остаётся опубликованной, но обычные назначения выпусков выше {plan.release.version} отменяются.</li>
            </ul>
            <div className="field"><label htmlFor="rollback-minutes">Через сколько минут заменить, от 5 до 1440</label>
              <input id="rollback-minutes" type="number" min={5} max={1440} value={minutes} onChange={e => setMinutes(e.target.value)} style={{ width: 120 }} /></div>
            <p className="hint">Перед подписью появится окно подтверждения. Возврат подписывается ключом издателя из вашего хранилища.</p>
          </>}
      <ErrorLine text={action.error} />
    </Dialog>}
  </>;
}
