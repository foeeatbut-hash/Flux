/**
 * Строка-переключатель в Параметрах: хранит своё значение в localStorage и
 * сообщает об изменении событием, чтобы слушатели не тянули сюда импорт.
 *
 * Отдельным файлом по той же причине, что и лист «Общие»: экран Параметров
 * упирался в потолок размера.
 */
import React, { useState } from 'react';
import { SettingRow, Switch } from '../ui';

export default function ToggleRow({ storageKey, event, title, desc }: {
  storageKey: string; event: string; title: string; desc: string;
}) {
  const [on, setOn] = useState<boolean>(() => {
    try { return localStorage.getItem(storageKey) !== '0'; } catch { return true; }
  });
  const flip = () => {
    const next = !on;
    setOn(next);
    try { localStorage.setItem(storageKey, next ? '1' : '0'); } catch (_) {}
    try { window.dispatchEvent(new CustomEvent(event)); } catch (_) {}
  };
  return (
    <SettingRow title={title} desc={desc}>
      <Switch label={title} checked={on} onChange={flip} />
    </SettingRow>
  );
}
