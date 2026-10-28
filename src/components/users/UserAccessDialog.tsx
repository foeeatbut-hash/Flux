import React, { useMemo, useState } from 'react';
import { dataService, type User } from '../../services/dataService';
import NameFields, { type NameValue } from '../NameFields';
import DepartmentPicker from './DepartmentPicker';
import PositionFields, { type PositionFieldsValue } from './PositionFields';
import PermissionRows from './PermissionRows';
import { parsePermissions } from '../../lib/permissions';
import { cleanUserPermissions } from '../../lib/userPermissions';
import type { Role } from '../../lib/roles';
import type { DepartmentRow } from '../../services/departmentService';
import { extraPositionCodes, mergePositionPermissions, primaryPositionCode } from '../../../shared/positions';
import { useModalStore } from '../../store/modalStore';
import { Btn, Dialog, Field, Input, Switch } from '../ui';

const { openConfirm } = useModalStore.getState();

const pad = (n: number) => String(n).padStart(2, '0');
const toDateInputValue = (value: any): string => {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const presetDate = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return toDateInputValue(d);
};

interface Props {
  user: User;
  /** Должности справочника без уровней доступа */
  positions: Role[];
  departments: DepartmentRow[];
  isOwner: boolean;
  mayManage: boolean;
  onClose: () => void;
  /** Сохранено или удалено: список перечитывается снаружи */
  onChanged: () => void | Promise<void>;
  addToast: (message: string, type?: any) => void;
}

/**
 * Карточка доступа сотрудника: профиль, должности, срок, права.
 * Уровень доступа и полномочия администратора меняет только владелец.
 */
export default function UserAccessDialog({ user, positions, departments, isOwner, mayManage, onClose, onChanged, addToast }: Props) {
  // У профилей, заведённых до раздельного хранения, частей ФИО может не быть —
  // разбираем единую строку, чтобы форма не открылась пустой.
  const words = String(user.name || '').replace(/\s*\(.*\)\s*$/, '').split(/\s+/).filter(Boolean);
  const [nameValue, setNameValue] = useState<NameValue>({
    lastName: user.lastName || words[0] || '',
    firstName: user.firstName || words[1] || '',
    middleName: user.middleName || words.slice(2).join(' ') || '',
    gender: user.gender || '',
    birthDate: toDateInputValue(user.birthDate),
  });
  const [symbol, setSymbol] = useState(user.symbol);
  const [pos, setPos] = useState<PositionFieldsValue>({
    primary: primaryPositionCode(user) || '',
    extras: extraPositionCodes(user),
    level: user.role === 'ADMIN' ? 'ADMIN' : 'EMPLOYEE',
  });
  const [password, setPassword] = useState('');
  const [active, setActive] = useState(user.isActive !== false);
  const [validUntil, setValidUntil] = useState(toDateInputValue(user.validUntil));
  const [perms, setPerms] = useState(() => parsePermissions(user.permissions));
  const [dept, setDept] = useState(user.departmentId || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const legacy = !!(user as any).legacyBootstrap;

  // Что уже дают выбранные должности: пересчитывается, пока их меняют в карточке
  const positionPerms = useMemo(() => {
    const raw = (code: string) => positions.find((p) => p.code === code)?.permissions;
    return mergePositionPermissions(raw(pos.primary), pos.extras.map(raw)) as any;
  }, [positions, pos.primary, pos.extras]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!symbol.trim()) { setError('Укажите табельный номер (логин)'); return; }
    if (!pos.primary) { setError('Выберите основную должность'); return; }
    if (legacy && (!isOwner || symbol.trim().toLowerCase() === user.symbol.trim().toLowerCase() || password.trim().length < 8)) {
      setError('Перенос начального профиля требует нового логина и нового пароля длиной не менее 8 символов.');
      return;
    }
    const clean = cleanUserPermissions(perms);
    setBusy(true);
    try {
      const res = await dataService.updateUser(user.id, {
        lastName: nameValue.lastName.trim(),
        firstName: nameValue.firstName.trim(),
        middleName: nameValue.middleName.trim(),
        gender: nameValue.gender,
        birthDate: nameValue.birthDate || null,
        symbol: symbol.trim(),
        positionCode: pos.primary,
        extraPositions: pos.extras,
        // Уровень шлёт только владелец: остальным сервер всё равно его не отдаст
        ...(isOwner ? { accessLevel: pos.level === 'ADMIN' ? 'ADMIN' as const : 'EMPLOYEE' as const } : {}),
        ...(password.trim() ? { password: password.trim() } : {}),
        isActive: active,
        validUntil: validUntil ? new Date(`${validUntil}T23:59:59`).toISOString() : null,
        permissions: Object.keys(clean).length ? JSON.stringify(clean) : null,
        // Подразделение шлём, только если его изменили: правка карточки без права переводов не должна упираться в отказ
        ...(dept !== (user.departmentId || '') ? { departmentId: dept || null } : {}),
      });
      if (!res || res.success !== true) throw new Error((res && res.message) || 'Сервер недоступен — изменения не сохранены');
      addToast('Профиль сотрудника обновлен', 'success');
      onClose();
      await onChanged();
    } catch (err: any) {
      setError(err.message || 'Не удалось сохранить изменения');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!await openConfirm(`Удалить профиль «${user.name}»?`, 'Сообщения и файлы этого сотрудника останутся, но потеряют автора. Действие необратимо.', { confirmLabel: 'Удалить профиль', tone: 'danger' })) return;
    setBusy(true);
    try {
      const res = await dataService.deleteUser(user.id);
      if (!res || res.success !== true) throw new Error((res && res.message) || 'Сервер недоступен — профиль не удален');
      addToast('Профиль удален', 'success');
      onClose();
      await onChanged();
    } catch (err: any) {
      setError(err.message || 'Не удалось удалить профиль');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Управление доступом" width="max-w-lg" onClose={onClose} busy={busy}
      footer={<>
        <Btn size="lg" tone="danger" disabled={busy} onClick={remove} className="mr-auto">Удалить профиль</Btn>
        <Btn size="lg" disabled={busy} onClick={onClose}>Отмена</Btn>
        <Btn size="lg" tone="primary" type="submit" form="user-edit-form" disabled={busy}>{busy ? 'Сохранение…' : 'Сохранить'}</Btn>
      </>}>
      <p className="mb-3">
        Сотрудник: <span className="text-slate-900 dark:text-white">{user.name}</span> <span className="code text-slate-400">{user.symbol}</span>
      </p>
      {isOwner && legacy && <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 mb-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
        Перенос начального профиля: задайте личный логин и новый пароль (не менее 8 символов). Профиль сохранит прежний ID, файлы и историю; все прежние входы будут отозваны.
      </div>}
      {error && <p className="fx-error mb-3">{error}</p>}
      <form id="user-edit-form" onSubmit={save} className="space-y-3">
        <NameFields value={nameValue} onChange={setNameValue} disabled={busy} />
        <Field label="Табельный номер (логин)" hint={legacy ? 'Укажите новый личный логин, отличный от прежнего.' : 'Логин для входа: уникальный, без символа @.'}>
          <Input value={symbol} onChange={(e) => setSymbol(e.target.value)} disabled={busy} className="code" />
        </Field>
        <PositionFields positions={positions} value={pos} onChange={setPos} canSetLevel={isOwner} disabled={busy} />
        <Field label={legacy ? 'Новый пароль (обязательно)' : 'Новый пароль'}>
          <Input value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} placeholder={legacy ? 'Не менее 8 символов' : 'Не менять'} />
        </Field>
        <Field label="Подразделение" hint={mayManage ? undefined : 'Переводит администратор с правом управления сотрудниками.'}>
          <DepartmentPicker value={dept} onChange={setDept} departments={departments} emptyLabel="Без подразделения" disabled={busy || !mayManage} ariaLabel="Подразделение сотрудника" />
        </Field>
        <Field label="Доступ действует до">
          <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} disabled={busy} />
          <span className="flex flex-wrap gap-1 mt-1.5">
            <Btn size="sm" disabled={busy} onClick={() => setValidUntil(presetDate(30))}>+30 дней</Btn>
            <Btn size="sm" disabled={busy} onClick={() => setValidUntil(presetDate(90))}>+90 дней</Btn>
            <Btn size="sm" disabled={busy} onClick={() => setValidUntil(presetDate(365))}>+1 год</Btn>
            <Btn size="sm" disabled={busy} onClick={() => setValidUntil('')}>Бессрочно</Btn>
          </span>
        </Field>

        <div className="fx-set-row">
          <div className="fx-set-text">Профиль активен<div className="fx-set-desc">Снимите, чтобы сразу закрыть вход</div></div>
          <Switch checked={active} onChange={setActive} label="Профиль активен" disabled={busy} />
        </div>

        <PermissionRows level={pos.level} isOwner={isOwner} perms={perms} setPerms={setPerms} positionPerms={positionPerms} disabled={busy} />
      </form>
    </Dialog>
  );
}
