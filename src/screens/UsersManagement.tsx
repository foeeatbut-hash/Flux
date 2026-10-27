import React, { useEffect, useState } from 'react';
import { useStore } from '../store/store';
import SignatureEditor from '../components/SignatureEditor';
import { useToastStore } from '../store/toastStore';
import { dataService, User } from '../services/dataService';
import { FEATURES, ADMIN_FEATURES, canAdmin, OPEN_BY_DEFAULT, entryOf, parsePermissions, PermMap } from '../lib/permissions';
import NameFields, { NameValue, EMPTY_NAME } from '../components/NameFields';
import { Role, loadRoles, roleByCode, roleColorClass, isTopAdmin } from '../lib/roles';
import { usePresenceStore, presenceLabel } from '../store/presenceStore';
import PresencePanel from '../components/users/PresencePanel';
import EmployeeImportDialog from '../components/users/EmployeeImportDialog';
import UpdateCampaignPanel from '../components/users/UpdateCampaignPanel';
import DepartmentsTab from '../components/users/DepartmentsTab';
import DepartmentFilterPane, { matchesDepartmentFilter, type DepartmentFilter } from '../components/users/DepartmentFilterPane';
import DepartmentPicker from '../components/users/DepartmentPicker';
import DepartmentUndoBar from '../components/users/DepartmentUndoBar';
import AssignDialog from '../components/users/AssignDialog';
import LegacyWizard from '../components/users/LegacyWizard';
import { useDepartmentStore } from '../store/departmentStore';
import { departmentLabel, departmentPath } from '../../shared/departments';
import { cleanUserPermissions } from '../lib/userPermissions';
import { useAppContext } from '../store/policyStore';
import { useNavigate } from 'react-router-dom';
import { fullNameOf } from '../lib/declension';
import RoleIcon from '../components/RoleIcon';
import { PanelLeft, Plus, Search } from 'lucide-react';
import { useModalStore } from '../store/modalStore';
import { countOf } from '../lib/plural';
import { updateService, type UpdateDevice } from '../services/updateService';
import { isNewer } from '../lib/updates';
import { SectionHead, Tabs, Toolbar, FilterSeg, Seg, Btn, Input, Select, Empty, Status, Chip, Avatar, Dialog, Field, Switch } from '../components/ui';

// Диалоги программы вместо системных окон Windows
const { openConfirm } = useModalStore.getState();

export default function UsersManagement() {
  const user = useStore((s) => s.user);
  const isOwner = user?.role === 'OWNER';
  const mayCreate = canAdmin(user, 'admin.users.create');
  const mayManage = canAdmin(user, 'admin.users.manage');
  const editable = (employee: User) => employee.role !== 'OWNER' && (employee.role !== 'ADMIN' || isOwner) && mayManage;
  const { addToast } = useToastStore();
  
  const [usersList, setUsersList] = useState<User[]>([]);
  // Кто в сети — общий список программы (store/presenceStore)
  const onlineIds = usePresenceStore(s => s.online);
  /**
   * Отбор в списке. Раньше его не было вовсе: тридцать сотрудников искали
   * прокруткой, а вопросы «у кого истекает доступ» и «кто ещё без подписи»
   * приходилось решать, открывая карточки по одной.
   */
  const [q, setQ] = useState('');
  const [pick, setPick] = useState<'all' | 'active' | 'off' | 'soon' | 'nosign'>('all');
  const [sortBy, setSortBy] = useState<'name' | 'role' | 'created'>('name');
  // Кому правим подпись; null — окно закрыто
  const [signFor, setSignFor] = useState<any | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  // Вкладки: список — главное, обновления вынесены отдельно, чтобы не
  // сдвигать список вниз. focus — с какого сотрудника открыта вкладка «Обновления»
  const [tab, setTab] = useState<'list' | 'departments' | 'updates'>('list');
  // Подразделения (docs/departments.md): фильтр-дерево, отметка строк для перевода, окна мастера
  const departments = useDepartmentStore((s) => s.departments);
  const rootId = useDepartmentStore((s) => s.rootId);
  const unassignedCount = useDepartmentStore((s) => s.unassigned);
  const [deptFilter, setDeptFilter] = useState<DepartmentFilter>('');
  const [paneOpen, setPaneOpen] = useState<boolean>(() => { try { return localStorage.getItem('flux_users_dept_pane') !== '0'; } catch { return true; } });
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [assign, setAssign] = useState<{ userIds: string[]; target: string } | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [batch, setBatch] = useState<{ message: string; token: string } | null>(null);
  const [newDept, setNewDept] = useState('');
  const [editDept, setEditDept] = useState('');
  const [focus, setFocus] = useState<{ userId: string; n: number } | undefined>();
  const [devices, setDevices] = useState<UpdateDevice[]>([]);
  const [latest, setLatest] = useState('');
  
  // New User Form State
  const [roles, setRoles] = useState<Role[]>([]);
  const [nameValue, setNameValue] = useState<NameValue>(EMPTY_NAME);
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('ENGINEER_VENT');
  const [validUntil, setValidUntil] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  // Редактирование существующего сотрудника
  const [editUser, setEditUser] = useState<User | null>(null);

  const [editNameValue, setEditNameValue] = useState<NameValue>(EMPTY_NAME);
  const [editName, setEditName] = useState('');
  const [editSymbol, setEditSymbol] = useState('');
  const [editRole, setEditRole] = useState('ENGINEER_VENT');
  const [editPassword, setEditPassword] = useState('');
  const [editActive, setEditActive] = useState(true);
  const [editValidUntil, setEditValidUntil] = useState('');
  const [editPerms, setEditPerms] = useState<PermMap>({});
  const [editError, setEditError] = useState('');
  const [isEditSubmitting, setIsEditSubmitting] = useState(false);

  // дата+время для input[type=datetime-local]
  const toDateTimeInput = (value: any): string => {
    if (!value) return '';
    const d = new Date(value);
    if (isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const togglePerm = (feature: string, enabled: boolean) => {
    setEditPerms((prev) => ({ ...prev, [feature]: { enabled, until: prev[feature]?.until ?? null } }));
  };
  const setPermUntil = (feature: string, value: string) => {
    setEditPerms((prev) => ({
      ...prev,
      [feature]: { enabled: prev[feature]?.enabled ?? true, until: value ? new Date(value).toISOString() : null },
    }));
  };

  const toDateInputValue = (value: any): string => {
    if (!value) return '';
    const d = new Date(value);
    if (isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  const presetDate = (days: number): string => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return toDateInputValue(d);
  };

  const toDateOnly = (v: any): string => {
    if (!v) return '';
    const d = new Date(v);
    if (isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  useEffect(() => {
    let alive = true;
    loadRoles().then((list) => { if (alive) setRoles(list); });
    const onChanged = () => loadRoles(true).then((list) => { if (alive) setRoles(list); });
    window.addEventListener('flux:roles-changed', onChanged);
    return () => { alive = false; window.removeEventListener('flux:roles-changed', onChanged); };
  }, []);

  // Новый сотрудник по умолчанию попадает в подразделение, выбранное в фильтре
  const openCreate = () => {
    setNewDept(deptFilter && deptFilter !== 'none' ? deptFilter : '');
    setIsModalOpen(true);
  };

  const openEdit = (emp: User) => {
    if (!editable(emp)) return;
    setEditUser(emp);
    setEditDept(emp.departmentId || '');
    // У профилей, заведённых до раздельного хранения, частей может не быть —
    // разбираем единую строку, чтобы форма не открылась пустой.
    const w = String(emp.name || '').replace(/\s*\(.*\)\s*$/, '').split(/\s+/).filter(Boolean);
    setEditNameValue({
      lastName: emp.lastName || w[0] || '',
      firstName: emp.firstName || w[1] || '',
      middleName: emp.middleName || w.slice(2).join(' ') || '',
      gender: emp.gender || '',
      birthDate: toDateOnly(emp.birthDate),
    });
    setEditName(emp.name);
    setEditSymbol(emp.symbol);
    setEditRole(emp.role);
    setEditPassword('');
    setEditActive(emp.isActive !== false);
    setEditValidUntil(toDateInputValue(emp.validUntil));
    setEditPerms(parsePermissions(emp.permissions));
    setEditError('');
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editUser || !editable(editUser)) return;
    setEditError('');
    setIsEditSubmitting(true);
    if (!editSymbol.trim()) { setEditError('Укажите табельный номер (логин)'); setIsEditSubmitting(false); return; }
    const cleanPerms = cleanUserPermissions(editPerms);
    if ((editUser as any).legacyBootstrap && (!isOwner || editSymbol.trim().toLowerCase() === editUser.symbol.trim().toLowerCase() || editPassword.trim().length < 8)) {
      setEditError('Перенос начального профиля требует нового логина и нового пароля длиной не менее 8 символов.');
      setIsEditSubmitting(false);
      return;
    }
    try {
      const res = await dataService.updateUser(editUser.id, {
        lastName: editNameValue.lastName.trim(),
        firstName: editNameValue.firstName.trim(),
        middleName: editNameValue.middleName.trim(),
        gender: editNameValue.gender,
        birthDate: editNameValue.birthDate || null,
        symbol: editSymbol.trim(),
        role: editRole,
        ...(editPassword.trim() ? { password: editPassword.trim() } : {}),
        isActive: editActive,
        validUntil: editValidUntil ? new Date(`${editValidUntil}T23:59:59`).toISOString() : null,
        permissions: Object.keys(cleanPerms).length ? JSON.stringify(cleanPerms) : null,
        // Подразделение шлём, только если его изменили: правка карточки без права переводов не должна упираться в отказ
        ...(editDept !== (editUser.departmentId || '') ? { departmentId: editDept || null } : {}),
      });
      if (!res || res.success !== true) {
        throw new Error((res && res.message) || 'Сервер недоступен — изменения не сохранены');
      }
      addToast('Профиль сотрудника обновлен', 'success');
      setEditUser(null);
      await loadUsers();
    } catch (err: any) {
      setEditError(err.message || 'Не удалось сохранить изменения');
    } finally {
      setIsEditSubmitting(false);
    }
  };

  const handleDeleteUser = async () => {
    if (!editUser || !editable(editUser)) return;
    if (!await openConfirm(`Удалить профиль «${editUser.name}»?`, 'Сообщения и файлы этого сотрудника останутся, но потеряют автора. Действие необратимо.', { confirmLabel: 'Удалить профиль', tone: 'danger' })) return;
    setIsEditSubmitting(true);
    try {
      const res = await dataService.deleteUser(editUser.id);
      if (!res || res.success !== true) {
        throw new Error((res && res.message) || 'Сервер недоступен — профиль не удален');
      }
      addToast('Профиль удален', 'success');
      setEditUser(null);
      await loadUsers();
    } catch (err: any) {
      setEditError(err.message || 'Не удалось удалить профиль');
    } finally {
      setIsEditSubmitting(false);
    }
  };

  // Доступ — точка и слово: активен / отключён / до даты / истёк
  const getAccessBadge = (emp: User) => {
    if (emp.isActive === false) return <Status tone="rose">Отключен</Status>;
    if (emp.validUntil) {
      const until = new Date(emp.validUntil);
      const dateStr = until.toLocaleDateString('ru-RU');
      if (until.getTime() < Date.now()) return <Status tone="rose">Истек {dateStr}</Status>;
      return <Status tone="amber">до {dateStr}</Status>;
    }
    return <Status tone="emerald">Активен</Status>;
  };

  // 1. Load users list from database
  const loadUsers = async () => {
    setIsLoading(true);
    try {
      const data = await dataService.getUsers();
      setUsersList(data || []);
    } catch (err: any) {
      console.error(err);
      addToast('Ошибка при загрузке списка сотрудников', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
    void useDepartmentStore.getState().load();
  }, []);

  // 2. Validate and handle user registration
  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mayCreate) return;
    setFormError('');

    const trimmedName = fullNameOf(nameValue);
    const trimmedSymbol = symbol.trim();
    const trimmedPassword = password.trim();

    if (!nameValue.lastName.trim() || !nameValue.firstName.trim()) {
      setFormError('Укажите фамилию и имя сотрудника');
      return;
    }
    if (!trimmedSymbol) {
      setFormError('Укажите табельный номер / логин');
      return;
    }
    if (!trimmedPassword) {
      setFormError('Укажите пароль доступа');
      return;
    }

    // Checking for special chars like logic symbols to avoid messy names or SQL-likes
    if (trimmedSymbol.includes('@')) {
      setFormError('Табельный номер должен быть обычными цифрами или буквами без символа @');
      return;
    }

    setIsSubmitting(true);
    try {
      await dataService.createUser({
        lastName: nameValue.lastName.trim(),
        firstName: nameValue.firstName.trim(),
        middleName: nameValue.middleName.trim(),
        gender: nameValue.gender,
        birthDate: nameValue.birthDate || null,
        symbol: trimmedSymbol,
        password: trimmedPassword,
        role: role,
        validUntil: validUntil ? new Date(`${validUntil}T23:59:59`).toISOString() : null,
        ...(newDept ? { departmentId: newDept } : {}),
      });
      addToast('Сотрудник успешно добавлен в базу данных!', 'success');
      
      // Close modal and reset fields
      setIsModalOpen(false);
      setNameValue(EMPTY_NAME);
      setName('');
      setSymbol('');
      setPassword('');
      setRole('ENGINEER_VENT');
      setValidUntil('');

      // Reload users list
      await loadUsers();
    } catch (err: any) {
      console.error(err);
      const isDuplicate = err.message?.includes('P2002') || err.message?.includes('уже внесен') || err.message?.includes('exist');
      const errorMsg = isDuplicate 
        ? 'Ошибка: сотрудник с таким табельным номером уже внесен в базу данных!'
        : (err.message || 'Не удалось зарегистрировать нового сотрудника');
      setFormError(errorMsg);
      addToast(errorMsg, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  // 3. User-friendly role localization names with customized icon visual tags
  /** Через сколько дней доступ считаем истекающим: неделя — успеть продлить */
  const SOON_DAYS = 7;

  /** Состояние доступа одной строкой — им же считаем счётчики и фильтруем */
  const accessOf = (emp: User): 'off' | 'expired' | 'soon' | 'ok' => {
    if (emp.isActive === false) return 'off';
    if (!emp.validUntil) return 'ok';
    const left = new Date(emp.validUntil).getTime() - Date.now();
    if (isNaN(left)) return 'ok';
    if (left < 0) return 'expired';
    return left < SOON_DAYS * 864e5 ? 'soon' : 'ok';
  };

  // Версии программ сотрудников для колонки «Версия». Ошибка запроса не
  // ломает список: колонка просто остаётся пустой
  useEffect(() => {
    if (!mayManage || tab !== 'list') return;
    let alive = true;
    updateService.devices().then(r => { if (alive) { setDevices(r.devices); setLatest(r.releases[0]?.version || ''); } }).catch(() => {});
    return () => { alive = false; };
  }, [mayManage, tab]);
  const versionOf = (id: string) => {
    const mine = devices.filter(d => d.userId === id);
    if (!mine.length) return null;
    const versions = [...new Set(mine.map(d => d.version).filter(Boolean))];
    return { label: versions.length > 1 ? 'разные' : versions[0] || '?', stale: !!latest && mine.some(d => d.version && isNewer(latest, d.version)) };
  };

  const counts = React.useMemo(() => {
    let active = 0, off = 0, soon = 0, nosign = 0;
    for (const e of usersList) {
      const a = accessOf(e);
      if (a === 'off' || a === 'expired') off++; else active++;
      if (a === 'soon' || a === 'expired') soon++;
      if (!(e as any).hasSignature) nosign++;
    }
    return { total: usersList.length, active, off, soon, nosign };
  }, [usersList]);

  const shown = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = usersList.filter((e) => {
      const a = accessOf(e);
      if (pick === 'active' && (a === 'off' || a === 'expired')) return false;
      if (pick === 'off' && a !== 'off' && a !== 'expired') return false;
      if (pick === 'soon' && a !== 'soon' && a !== 'expired') return false;
      if (pick === 'nosign' && (e as any).hasSignature) return false;
      if (!matchesDepartmentFilter(deptFilter, e.departmentId, departments)) return false;
      if (!needle) return true;
      // Ищем и по роли: «покажи всех КИПиА» — обычный вопрос к этому списку
      const role = roleByCode(e.role, roles).name || e.role || '';
      return `${e.name} ${e.symbol} ${role} ${departmentLabel(departments, e.departmentId)}`.toLowerCase().includes(needle);
    });
    const byName = (a: User, b: User) => (a.name || '').localeCompare(b.name || '', 'ru');
    if (sortBy === 'role') {
      return [...list].sort((a, b) => {
        const ra = roleByCode(a.role, roles), rb = roleByCode(b.role, roles);
        // Внутри роли — по алфавиту: иначе порядок внутри группы случайный
        return (ra.level - rb.level) || (ra.name || '').localeCompare(rb.name || '', 'ru') || byName(a, b);
      });
    }
    if (sortBy === 'created') {
      return [...list].sort((a, b) =>
        new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
    }
    return [...list].sort(byName);
  }, [usersList, q, pick, sortBy, roles, deptFilter, departments]);

  const deptLabelOf = (emp: User) => departmentLabel(departments, emp.departmentId);
  const togglePane = () => setPaneOpen((open) => {
    try { localStorage.setItem('flux_users_dept_pane', open ? '0' : '1'); } catch { /* память браузера недоступна — выбор просто не запомнится */ }
    return !open;
  });

  /** Инициалы для кружка в строке — «Раупов Хусрав» → «РХ» */
  const initialsOf = (emp: User) => {
    const parts = String(emp.name || emp.symbol || '').trim().split(/\s+/).filter(Boolean);
    return (parts.slice(0, 2).map((x) => x[0]).join('') || '?').toUpperCase();
  };

  // Роль сотрудника может не найтись среди ролей (завели до справочника
  // ролей). Раньше список тогда показывал первую роль — «Администратор», —
  // хотя у человека другая: показываем её как есть
  const roleOptions = (current: string) => {
    const opts = roles.filter(r => r.code !== 'OWNER' && (r.code !== 'ADMIN' || isOwner)).map((r) => ({ value: r.code, label: r.name }));
    return current && !roles.some((r) => r.code === current) ? [{ value: current, label: `${current} (нет в списке ролей)` }, ...opts] : opts;
  };

  // Роль — значок цветом роли и название обычным текстом: цвет роли задают
  // в Настройках, но плашка с рамкой на каждой строке перекрикивала таблицу
  const getRoleBadge = (userRole: string) => {
    const r = roleByCode(userRole, roles);
    const tint = roleColorClass(r.color).split(/\s+/).filter((c) => /^(dark:)?text-/.test(c)).join(' ');
    return (
      <span className="inline-flex items-center gap-1.5">
        <RoleIcon name={r.icon} className={`w-3.5 h-3.5 shrink-0 ${tint}`} />
        {r.name}
        {r.level <= 1 && <span className="text-slate-400">· 1 уровень</span>}
      </span>
    );
  };

  return (
    <div id="users-management-root" className="fx-page @container">
      <SectionHead
        title="Сотрудники"
        count={countOf(counts.total, 'сотрудник')}
        actions={(mayCreate || mayManage) && <>{<Btn onClick={() => setIsImportOpen(true)} title="Импортировать список сотрудников">Импортировать</Btn>}{mayCreate && <Btn tone="primary" onClick={() => openCreate()} title="Добавить сотрудника"><Plus />Добавить сотрудника</Btn>}</>}
      >
        <Tabs label="Разделы" value={tab} onChange={setTab} tabs={[{ value: 'list', label: 'Список' }, { value: 'departments', label: 'Подразделения' }, ...(mayManage ? [{ value: 'updates' as const, label: 'Обновления' }] : [])]} />
      </SectionHead>
      {isOwner && usersList.some((employee: any) => employee.legacyBootstrap) && <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100" role="status">
        Начальный профиль администратора заблокирован. Откройте его карточку и перенесите на личный логин с новым паролем. ID, файлы и история сохранятся.
      </div>}
      {/* Фильтр со счётчиками — он же сводка: вопросы «кто отключён» и «у кого
          истекает» задают чаще, чем ищут человека по фамилии */}
      {batch && <DepartmentUndoBar message={batch.message} token={batch.token} onClose={() => setBatch(null)} onUndone={() => { setBatch(null); setChecked(new Set()); void loadUsers(); addToast('Перевод отменён', 'success'); }} />}
      {tab === 'updates' && mayManage ? <UpdateCampaignPanel employeeIds={shown.map(employee => employee.id)} focus={focus} />
      : tab === 'departments' ? <DepartmentsTab users={usersList} canManage={mayManage}
          onAssign={(userIds, target) => setAssign({ userIds, target })} onWizard={() => setWizardOpen(true)}
          onBatch={(message, token) => { if (token) setBatch({ message, token }); void loadUsers(); }} />
      : <>
      <Toolbar>
        <Btn tone="ghost" size="sm" aria-pressed={paneOpen} onClick={togglePane} title={paneOpen ? 'Скрыть дерево подразделений' : 'Показать дерево подразделений'}><PanelLeft />Подразделения</Btn>
        <label className="relative w-64 max-w-full">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Фамилия, логин, роль, подразделение" aria-label="Поиск сотрудника" className="pl-7" />
        </label>
        <FilterSeg label="Отбор сотрудников" value={pick} onChange={setPick} options={[
          { value: 'all', label: 'Все' },
          { value: 'active', label: 'Работают', count: counts.active },
          { value: 'off', label: 'Закрыт доступ', count: counts.off },
          { value: 'soon', label: 'Истекает', count: counts.soon },
          { value: 'nosign', label: 'Без подписи', count: counts.nosign },
        ]} />
        <span className="ml-auto" />
        <Seg label="Порядок" value={sortBy} onChange={setSortBy} options={[
          { value: 'name', label: 'По фамилии' },
          { value: 'role', label: 'По роли' },
          { value: 'created', label: 'Сначала новые' },
        ]} />
      </Toolbar>
      {/* Отмеченные строки: массовый перевод — полосой под панелью, а не в ней: панель и так тесная */}
      {mayManage && checked.size > 0 && <div role="status" className="flex flex-wrap items-center gap-2 border-b border-[var(--flux-line)] bg-[var(--flux-sel)] px-4 py-1.5 text-[13px]">
        <span className="mr-auto">Отмечено: {countOf(checked.size, 'сотрудник')}</span>
        <Btn size="sm" tone="primary" onClick={() => setAssign({ userIds: [...checked], target: deptFilter && deptFilter !== 'none' ? deptFilter : '' })}>Перевести в подразделение…</Btn>
        <Btn size="sm" tone="ghost" onClick={() => setChecked(new Set())}>Снять отметки</Btn>
      </div>}
      {/* Кто здесь сейчас — строкой; кто когда заходил — по нажатию */}
      <PresencePanel people={usersList as any} />

      <div className="flex min-h-0 flex-1">
      {paneOpen && <DepartmentFilterPane departments={departments} value={deptFilter} onChange={(v) => { setDeptFilter(v); setChecked(new Set()); }} total={counts.total} unassigned={unassignedCount} />}
      {/* Свой контейнер: ширина таблицы без дерева слева, и колонки прячутся по ней, а не по ширине окна */}
      <div className="fx-page-body min-w-0 @container">
        {isLoading && usersList.length === 0 ? (
          <Empty title="Загрузка…" />
        ) : usersList.length === 0 ? (
          <Empty title="Сотрудников пока нет" text="Заведите первого — он получит логин, роль и права доступа.">
            {mayCreate && <Btn tone="primary" onClick={() => openCreate()} className="mt-3">Добавить сотрудника</Btn>}
          </Empty>
        ) : shown.length === 0 ? (
          <Empty title="Никто не подходит под отбор" text="Снимите фильтр или очистите поиск.">
            <Btn onClick={() => { setQ(''); setPick('all'); setDeptFilter(''); }} className="mt-3">Показать всех</Btn>
          </Empty>
        ) : (
          <table className="fx-table">
            <thead>
              <tr>
                {mayManage && <th className="w-8"><input type="checkbox" aria-label="Отметить всех показанных" className="cursor-pointer" checked={shown.length > 0 && shown.every((e) => checked.has(e.id))}
                  onChange={(ev) => setChecked(ev.target.checked ? new Set(shown.map((e) => e.id)) : new Set())} /></th>}
                <th>Сотрудник</th>
                <th className="hidden @[640px]:table-cell">Подразделение</th>
                <th className="hidden @[720px]:table-cell">Роль</th>
                <th>Доступ</th>
                <th className="hidden @[560px]:table-cell">Подпись</th>
                {mayManage && <th className="hidden @[860px]:table-cell">Версия</th>}
                <th className="hidden @[980px]:table-cell">Заведён</th>
                <th className="w-24" />
              </tr>
            </thead>
            <tbody>
              {shown.map((emp) => (
                <tr key={emp.id} className={checked.has(emp.id) ? 'is-sel' : undefined} onDoubleClick={() => openEdit(emp)} title="Двойное нажатие — открыть карточку сотрудника">
                  {mayManage && <td className="w-8"><input type="checkbox" className="cursor-pointer" aria-label={`Отметить: ${emp.name}`} checked={checked.has(emp.id)}
                    onChange={(ev) => setChecked((prev) => { const next = new Set(prev); if (ev.target.checked) next.add(emp.id); else next.delete(emp.id); return next; })} /></td>}
                  {/* ФИО и логин в одной строке: логин нужен всегда, а своей
                      колонки под него нет на узкой ширине */}
                  <td className="w-full max-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      {/* «В сети» — то же, что в чате, и по тому же правилу:
                          администратор виден наравне со всеми */}
                      <span title={onlineIds.includes(emp.id) ? presenceLabel(true, null) : undefined} aria-label={onlineIds.includes(emp.id) ? 'В сети' : undefined}>
                        <Avatar name={emp.name || emp.symbol || ''} online={onlineIds.includes(emp.id)} />
                      </span>
                      <span className="truncate text-slate-900 dark:text-white" title={emp.name}>{emp.name}</span>
                      <span className="code text-xs text-slate-400 shrink-0">{emp.symbol}</span>
                      {isOwner && (emp as any).legacyBootstrap && <Status tone="amber">Нужен перенос</Status>}
                      <span className="@[720px]:hidden text-slate-400 truncate">· {roleByCode(emp.role, roles).name}</span>
                    </div>
                  </td>
                  {/* Конечный отдел крупно, город мелко: путь «Новосибирск / ОВиК / Бригада 1»
                      обрезался с конца, и в узкой колонке оставался один город */}
                  <td className="hidden @[640px]:table-cell max-w-0 w-48 truncate" title={deptLabelOf(emp)}>{(() => {
                    const path = departmentPath(departments, emp.departmentId);
                    const leaf = path[path.length - 1];
                    if (!leaf) return <span className="text-slate-400">—</span>;
                    const city = path.length > 1 ? path.find((d) => d.kind === 'branch') : undefined;
                    return <>{leaf.name}{city && city.id !== leaf.id && <span className="ml-1.5 text-xs text-slate-500 dark:text-slate-400">{city.name}</span>}</>;
                  })()}</td>
                  <td className="hidden @[720px]:table-cell whitespace-nowrap">{getRoleBadge(emp.role)}</td>
                  <td className="whitespace-nowrap">{getAccessBadge(emp)}</td>
                  <td className="hidden @[560px]:table-cell whitespace-nowrap">
                    {/* Подпись видна прямо в строке: иначе, чтобы узнать, есть
                        ли она, надо открывать карточку каждого по очереди */}
                    <Chip tone={(emp as any).hasSignature ? 'emerald' : 'slate'} onClick={() => setSignFor(emp)}
                      title={(emp as any).hasSignature ? 'Подпись задана — открыть' : 'Подписи нет — задать'}>
                      {(emp as any).hasSignature ? 'есть' : 'нет'}
                    </Chip>
                  </td>
                  {mayManage && <td className="hidden @[860px]:table-cell whitespace-nowrap">{(() => {
                    const v = versionOf(emp.id);
                    return !v ? <span className="text-slate-400">—</span> : <span className="inline-flex items-center gap-1.5 tabular-nums">{v.label}
                      {v.stale && <Chip tone="amber" onClick={() => { setFocus({ userId: emp.id, n: Date.now() }); setTab('updates'); }} title="Версия устарела — назначить обновление">устарела</Chip>}</span>;
                  })()}</td>}
                  <td className="hidden @[980px]:table-cell text-slate-400 whitespace-nowrap">
                    {new Date(emp.createdAt || Date.now()).toLocaleDateString('ru-RU')}
                  </td>
                  <td>
                    <div className="fx-row-acts">
                      {editable(emp) && <Btn tone="ghost" size="sm" onClick={() => openEdit(emp)} title={`Карточка сотрудника: ${emp.name}`}>Изменить</Btn>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      </div>
      </>}

      {/* Подпись сотрудника — своё окно, вне AnimatePresence */}
      {signFor && (
        <SignatureEditor
          userId={signFor.id}
          userName={signFor.name || signFor.symbol}
          nameParts={{ lastName: signFor.lastName, firstName: signFor.firstName, middleName: signFor.middleName, name: signFor.name }}
          value={signFor.hasSignature ? 'есть' : null}
          heightMm={signFor.signatureHeightMm ?? 8}
          canEdit={user?.id === signFor.id || editable(signFor)}
          onSaved={(sig, mm) => setUsersList((prev) => prev.map((u: any) =>
            u.id === signFor.id ? { ...u, hasSignature: !!sig, signatureHeightMm: mm } : u))}
          onClose={() => setSignFor(null)}
        />
      )}

      {/* Регистрация сотрудника */}
      {isModalOpen && (
        <Dialog title="Регистрация сотрудника" onClose={() => setIsModalOpen(false)} busy={isSubmitting}
          footer={<>
            <Btn size="lg" disabled={isSubmitting} onClick={() => setIsModalOpen(false)}>Отмена</Btn>
            <Btn size="lg" tone="primary" type="submit" form="user-create-form" disabled={isSubmitting}>{isSubmitting ? 'Создание…' : 'Зарегистрировать'}</Btn>
          </>}>
          {formError && <p className="fx-error mb-3">{formError}</p>}
          <form id="user-create-form" onSubmit={handleCreateUser} className="space-y-3">
            <NameFields value={nameValue} onChange={setNameValue} disabled={isSubmitting} />
            <Field label="Табельный номер (ID)" hint="Логин для входа: уникальный, без символа @.">
              <Input required value={symbol} onChange={(e) => setSymbol(e.target.value)} disabled={isSubmitting} placeholder="Например, 4519" className="code" />
            </Field>
            <Field label="Пароль доступа в систему">
              <Input required value={password} onChange={(e) => setPassword(e.target.value)} disabled={isSubmitting} placeholder="Задайте надёжный пароль" />
            </Field>
            <Field label="Роль в системе">
              <Select value={role} onChange={setRole} disabled={isSubmitting} options={roles.filter(r => r.code !== 'OWNER' && (r.code !== 'ADMIN' || isOwner)).map((r) => ({ value: r.code, label: r.name }))} />
            </Field>
            <Field label="Подразделение" hint="Выбранное в фильтре списка подставляется само; можно оставить пустым.">
              <DepartmentPicker value={newDept} onChange={setNewDept} departments={departments} emptyLabel="Без подразделения" disabled={isSubmitting} ariaLabel="Подразделение сотрудника" />
            </Field>
            <Field label="Срок действия профиля" hint="После этой даты сотрудник не сможет войти. Пусто — бессрочно.">
              <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} disabled={isSubmitting} />
            </Field>
          </form>
        </Dialog>
      )}
      {assign && <AssignDialog userIds={assign.userIds.length ? assign.userIds : [...checked]} departments={departments} initialTarget={assign.target} onClose={() => setAssign(null)}
        onDone={(message, token) => { setAssign(null); setChecked(new Set()); if (token) setBatch({ message, token }); void loadUsers(); }} />}
      {wizardOpen && <LegacyWizard departments={departments} rootId={rootId} onClose={() => setWizardOpen(false)}
        onDone={(message, token) => { setWizardOpen(false); if (token) setBatch({ message, token }); void loadUsers(); }} />}
      {isImportOpen && <EmployeeImportDialog roles={roles} onClose={() => setIsImportOpen(false)} onComplete={() => { void loadUsers(); }} />}

      {/* Карточка сотрудника: профиль, срок, права */}
      {editUser && (
        <Dialog title="Управление доступом" width="max-w-lg" onClose={() => setEditUser(null)} busy={isEditSubmitting}
          footer={<>
            <Btn size="lg" tone="danger" disabled={isEditSubmitting} onClick={handleDeleteUser} className="mr-auto">Удалить профиль</Btn>
            <Btn size="lg" disabled={isEditSubmitting} onClick={() => setEditUser(null)}>Отмена</Btn>
            <Btn size="lg" tone="primary" type="submit" form="user-edit-form" disabled={isEditSubmitting}>{isEditSubmitting ? 'Сохранение…' : 'Сохранить'}</Btn>
          </>}>
          <p className="mb-3">
            Сотрудник: <span className="text-slate-900 dark:text-white">{editUser.name}</span> <span className="code text-slate-400">{editUser.symbol}</span>
          </p>
          {isOwner && (editUser as any).legacyBootstrap && <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 mb-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
            Перенос начального профиля: задайте личный логин и новый пароль (не менее 8 символов). Профиль сохранит прежний ID, файлы и историю; все прежние входы будут отозваны.
          </div>}
          {editError && <p className="fx-error mb-3">{editError}</p>}
          <form id="user-edit-form" onSubmit={handleSaveEdit} className="space-y-3">
            <NameFields value={editNameValue} onChange={setEditNameValue} disabled={isEditSubmitting} />
            <Field label="Табельный номер (логин)" hint={(editUser as any).legacyBootstrap ? 'Укажите новый личный логин, отличный от прежнего.' : 'Логин для входа: уникальный, без символа @.'}>
              <Input value={editSymbol} onChange={(e) => setEditSymbol(e.target.value)} disabled={isEditSubmitting} className="code" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Роль">
                <Select value={editRole} onChange={setEditRole} disabled={isEditSubmitting} options={roleOptions(editRole)} />
              </Field>
              <Field label={(editUser as any).legacyBootstrap ? 'Новый пароль (обязательно)' : 'Новый пароль'}>
                <Input value={editPassword} onChange={(e) => setEditPassword(e.target.value)} disabled={isEditSubmitting} placeholder={(editUser as any).legacyBootstrap ? 'Не менее 8 символов' : 'Не менять'} />
              </Field>
            </div>
            <Field label="Подразделение" hint={mayManage ? undefined : 'Переводит администратор с правом управления сотрудниками.'}>
              <DepartmentPicker value={editDept} onChange={setEditDept} departments={departments} emptyLabel="Без подразделения" disabled={isEditSubmitting || !mayManage} ariaLabel="Подразделение сотрудника" />
            </Field>
            <Field label="Доступ действует до">
              <Input type="date" value={editValidUntil} onChange={(e) => setEditValidUntil(e.target.value)} disabled={isEditSubmitting} />
              <span className="flex flex-wrap gap-1 mt-1.5">
                <Btn size="sm" disabled={isEditSubmitting} onClick={() => setEditValidUntil(presetDate(30))}>+30 дней</Btn>
                <Btn size="sm" disabled={isEditSubmitting} onClick={() => setEditValidUntil(presetDate(90))}>+90 дней</Btn>
                <Btn size="sm" disabled={isEditSubmitting} onClick={() => setEditValidUntil(presetDate(365))}>+1 год</Btn>
                <Btn size="sm" disabled={isEditSubmitting} onClick={() => setEditValidUntil('')}>Бессрочно</Btn>
              </span>
            </Field>

            <div className="fx-set-row">
              <div className="fx-set-text">Профиль активен<div className="fx-set-desc">Снимите, чтобы сразу закрыть вход</div></div>
              <Switch checked={editActive} onChange={setEditActive} label="Профиль активен" disabled={isEditSubmitting} />
            </div>

            {/* Права доступа по функциям */}
            <div>
              <div className="fx-label mt-2 mb-1">Права доступа</div>
              {editRole === 'ADMIN' ? (
                <div>
                  <Status tone="slate">Рабочие функции доступны администратору</Status>
                  <p className="fx-hint mt-2">Административные полномочия назначает владелец лично. Роль не даёт права выдавать обновления или менять подключение к базе.</p>
                  {isOwner && ADMIN_FEATURES.map(feature => {
                    const entry = editPerms[feature.id];
                    return <div key={feature.id} className="fx-set-row items-start">
                      <div className="fx-set-text">{feature.label}<div className="fx-set-desc">{feature.desc}</div>
                        {entry?.enabled && <label className="flex flex-wrap items-center gap-2 mt-2 text-xs text-slate-500 dark:text-slate-400">Действует до<Input type="datetime-local" value={toDateTimeInput(entry.until)} onChange={event => setPermUntil(feature.id, event.target.value)} disabled={isEditSubmitting} className="w-auto" /><span>{entry.until ? '' : 'Бессрочно'}</span></label>}
                      </div>
                      <Switch checked={!!entry?.enabled} onChange={value => togglePerm(feature.id, value)} label={feature.label} disabled={isEditSubmitting} />
                    </div>;
                  })}
                </div>
              ) : (
                <div>
                  {FEATURES.map((f) => {
                    const e = editPerms[f.id];
                    // Право, открытое по умолчанию, переключатель показывает таким,
                    // каким оно действует (роль, умолчание, личное); снятие пишет запрет
                    const open = OPEN_BY_DEFAULT.includes(f.id);
                    const on = open
                      ? !!entryOf({ ...parsePermissions((editUser as any)?.rolePermissions), ...editPerms }, f.id)?.enabled
                      : !!e?.enabled;
                    const isExpired = !!e?.until && new Date(e.until).getTime() < Date.now();
                    // Что уже даёт должность: иначе админ выдаёт лично то,
                    // что у человека и так есть, и потом не понимает,
                    // почему снятие галочки ничего не изменило.
                    const fromRole = !!parsePermissions((editUser as any)?.rolePermissions)[f.id]?.enabled;
                    return (
                      <div key={f.id} className="fx-set-row items-start">
                        <div className="fx-set-text">
                          <span className="inline-flex items-center gap-2 flex-wrap">
                            {f.label}
                            <span className="text-xs text-slate-400">{f.group}</span>
                            {fromRole && !on && <Status tone="sky">уже даёт роль</Status>}
                            {f.risky && <Status tone="amber">осторожно</Status>}
                            {open && e && !e.enabled && <Status tone="rose">запрещено лично</Status>}
                            {on && isExpired && <Status tone="rose">истекло</Status>}
                          </span>
                          <div className="fx-set-desc">
                            {f.desc}
                            {open && !e && on && ' У всех по умолчанию — выключите, чтобы запретить.'}
                          </div>
                          {on && (
                            <span className="flex items-center gap-2 flex-wrap mt-1.5 text-xs text-slate-500 dark:text-slate-400">
                              действует до
                              <Input type="datetime-local" value={toDateTimeInput(e?.until)} onChange={(ev) => setPermUntil(f.id, ev.target.value)} disabled={isEditSubmitting} className="w-auto" />
                              {e?.until
                                ? <Btn size="sm" tone="ghost" onClick={() => setPermUntil(f.id, '')}>бессрочно</Btn>
                                : <span>бессрочно</span>}
                            </span>
                          )}
                        </div>
                        <Switch checked={on} onChange={(v) => togglePerm(f.id, v)} label={f.label} disabled={isEditSubmitting} />
                      </div>
                    );
                  })}
                  <p className="fx-hint mt-1.5">Административные полномочия назначает только владелец Flux.</p>
                </div>
              )}
            </div>

          </form>
        </Dialog>
      )}
    </div>
  );
}
