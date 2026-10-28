import React, { useState } from 'react';
import { dataService } from '../../services/dataService';
import NameFields, { EMPTY_NAME, type NameValue } from '../NameFields';
import DepartmentPicker from './DepartmentPicker';
import PositionFields, { type PositionFieldsValue } from './PositionFields';
import type { Role } from '../../lib/roles';
import type { DepartmentRow } from '../../services/departmentService';
import { Btn, Dialog, Field, Input } from '../ui';

interface Props {
  /** Должности справочника без уровней доступа */
  positions: Role[];
  departments: DepartmentRow[];
  /** Подразделение, выбранное в фильтре списка, — подставляется само */
  initialDept: string;
  isOwner: boolean;
  onClose: () => void;
  /** Заведён: список перечитывается снаружи */
  onCreated: () => void | Promise<void>;
  addToast: (message: string, type?: any) => void;
}

/** Регистрация сотрудника: ФИО, логин, пароль, должности, подразделение, срок. */
export default function UserRegisterDialog({ positions, departments, initialDept, isOwner, onClose, onCreated, addToast }: Props) {
  const [nameValue, setNameValue] = useState<NameValue>(EMPTY_NAME);
  const [symbol, setSymbol] = useState('');
  const [password, setPassword] = useState('');
  const [pos, setPos] = useState<PositionFieldsValue>({ primary: '', extras: [], level: 'EMPLOYEE' });
  const [dept, setDept] = useState(initialDept);
  const [validUntil, setValidUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const login = symbol.trim();
    const pass = password.trim();
    if (!nameValue.lastName.trim() || !nameValue.firstName.trim()) { setError('Укажите фамилию и имя сотрудника'); return; }
    if (!login) { setError('Укажите табельный номер / логин'); return; }
    if (!pass) { setError('Укажите пароль доступа'); return; }
    // Символ @ в логине путает вход по почте и по табельному номеру
    if (login.includes('@')) { setError('Табельный номер должен быть обычными цифрами или буквами без символа @'); return; }
    if (!pos.primary) { setError('Выберите основную должность'); return; }
    setBusy(true);
    try {
      await dataService.createUser({
        lastName: nameValue.lastName.trim(),
        firstName: nameValue.firstName.trim(),
        middleName: nameValue.middleName.trim(),
        gender: nameValue.gender,
        birthDate: nameValue.birthDate || null,
        symbol: login,
        password: pass,
        positionCode: pos.primary,
        extraPositions: pos.extras,
        ...(isOwner && pos.level === 'ADMIN' ? { accessLevel: 'ADMIN' as const } : {}),
        validUntil: validUntil ? new Date(`${validUntil}T23:59:59`).toISOString() : null,
        ...(dept ? { departmentId: dept } : {}),
      });
      addToast('Сотрудник успешно добавлен в базу данных!', 'success');
      onClose();
      await onCreated();
    } catch (err: any) {
      console.error(err);
      const isDuplicate = err.message?.includes('P2002') || err.message?.includes('уже внесен') || err.message?.includes('exist');
      const message = isDuplicate
        ? 'Ошибка: сотрудник с таким табельным номером уже внесен в базу данных!'
        : (err.message || 'Не удалось зарегистрировать нового сотрудника');
      setError(message);
      addToast(message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Регистрация сотрудника" onClose={onClose} busy={busy}
      footer={<>
        <Btn size="lg" disabled={busy} onClick={onClose}>Отмена</Btn>
        <Btn size="lg" tone="primary" type="submit" form="user-create-form" disabled={busy}>{busy ? 'Создание…' : 'Зарегистрировать'}</Btn>
      </>}>
      {error && <p className="fx-error mb-3">{error}</p>}
      <form id="user-create-form" onSubmit={submit} className="space-y-3">
        <NameFields value={nameValue} onChange={setNameValue} disabled={busy} />
        <Field label="Табельный номер (ID)" hint="Логин для входа: уникальный, без символа @.">
          <Input required value={symbol} onChange={(e) => setSymbol(e.target.value)} disabled={busy} placeholder="Например, 4519" className="code" />
        </Field>
        <Field label="Пароль доступа в систему">
          <Input required value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} placeholder="Задайте надёжный пароль" />
        </Field>
        <PositionFields positions={positions} value={pos} onChange={setPos} canSetLevel={isOwner} disabled={busy} />
        <Field label="Подразделение" hint="Выбранное в фильтре списка подставляется само; можно оставить пустым.">
          <DepartmentPicker value={dept} onChange={setDept} departments={departments} emptyLabel="Без подразделения" disabled={busy} ariaLabel="Подразделение сотрудника" />
        </Field>
        <Field label="Срок действия профиля" hint="После этой даты сотрудник не сможет войти. Пусто — бессрочно.">
          <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} disabled={busy} />
        </Field>
      </form>
    </Dialog>
  );
}
