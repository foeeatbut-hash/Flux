import React, { useEffect, useState } from 'react';
import { useStore } from '../store/store';
import SignatureEditor from '../components/SignatureEditor';
import { useToastStore } from '../store/toastStore';
import { dataService, User } from '../services/dataService';
import { canAdmin } from '../lib/permissions';
import { Role, loadRoles, roleColorClass, positionsOnly } from '../lib/roles';
import { positionView, positionNames } from '../lib/positions';
import { usePresenceStore, presenceLabel } from '../store/presenceStore';
import PresencePanel from '../components/users/PresencePanel';
import EmployeeImportDialog from '../components/users/EmployeeImportDialog';
import DepartmentsTab from '../components/users/DepartmentsTab';
import DepartmentFilterPane, { matchesDepartmentFilter, type DepartmentFilter } from '../components/users/DepartmentFilterPane';
import PositionsTab from '../components/users/PositionsTab';
import UserAccessDialog from '../components/users/UserAccessDialog';
import UserRegisterDialog from '../components/users/UserRegisterDialog';
import DepartmentUndoBar from '../components/users/DepartmentUndoBar';
import AssignDialog from '../components/users/AssignDialog';
import LegacyWizard from '../components/users/LegacyWizard';
import { useDepartmentStore } from '../store/departmentStore';
import { departmentLabel, departmentPath } from '../../shared/departments';
import { useAppContext } from '../store/policyStore';
import { useNavigate } from 'react-router-dom';
import RoleIcon from '../components/RoleIcon';
import { PanelLeft, Plus, Search } from 'lucide-react';
import { countOf } from '../lib/plural';
import { SectionHead, Tabs, Toolbar, FilterSeg, Seg, Btn, Input, Empty, Status, Chip, Avatar } from '../components/ui';

export default function UsersManagement() {
  const user = useStore((s) => s.user);
  const isOwner = user?.role === 'OWNER';
  const mayCreate = canAdmin(user, 'admin.users.create');
  const mayManage = canAdmin(user, 'admin.users.manage');
  // Справочник должностей: владелец и администратор с правом «Должности: справочник»
  const mayPositions = canAdmin(user, 'admin.roles.manage');
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
  const [sortBy, setSortBy] = useState<'name' | 'position' | 'created'>('name');
  // Кому правим подпись; null — окно закрыто
  const [signFor, setSignFor] = useState<any | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRegisterOpen, setIsRegisterOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [tab, setTab] = useState<'list' | 'departments' | 'positions'>('list');
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
  // Справочник должностей; уровни доступа (OWNER, ADMIN) в нём не должности
  const [roles, setRoles] = useState<Role[]>([]);
  const positions = React.useMemo(() => positionsOnly(roles), [roles]);

  // Редактирование существующего сотрудника: карточка живёт в components/users/UserAccessDialog
  const [editUser, setEditUser] = useState<User | null>(null);

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
    setIsRegisterOpen(true);
  };

  const openEdit = (emp: User) => {
    if (!editable(emp)) return;
    setEditUser(emp);
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
      // Ищем и по должностям (основной и дополнительным): «покажи всех КИПиА» —
      // обычный вопрос к этому списку; уровень доступа ищется словом
      const level = e.role === 'OWNER' ? 'владелец' : e.role === 'ADMIN' ? 'администратор' : '';
      return `${e.name} ${e.symbol} ${positionNames(e, roles)} ${level} ${departmentLabel(departments, e.departmentId)}`.toLowerCase().includes(needle);
    });
    const byName = (a: User, b: User) => (a.name || '').localeCompare(b.name || '', 'ru');
    if (sortBy === 'position') {
      // По основной должности; у кого её нет — в конец
      const main = (u: User) => positionView(u, roles).primary;
      return [...list].sort((a, b) => {
        const ra = main(a), rb = main(b);
        if (!ra || !rb) return (ra ? 0 : 1) - (rb ? 0 : 1) || byName(a, b);
        // Внутри должности — по алфавиту: иначе порядок внутри группы случайный
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

  // Должность — значок цветом должности и название обычным текстом: цвет
  // задают в справочнике, но плашка с рамкой на каждой строке перекрикивала
  // таблицу. Основная — названием, дополнительные — «+N» с полным списком в подсказке.
  const getPositionCell = (emp: User) => {
    const view = positionView(emp, roles);
    if (!view.primary) return <span className="text-slate-400" title="Основная должность не назначена">—</span>;
    const tint = roleColorClass(view.primary.color).split(/\s+/).filter((c) => /^(dark:)?text-/.test(c)).join(' ');
    return (
      <span className="inline-flex items-center gap-1.5">
        <RoleIcon name={view.primary.icon} className={`w-3.5 h-3.5 shrink-0 ${tint}`} />
        {view.primary.name}
        {view.extras.length > 0 && <span className="text-xs text-slate-400 tabular-nums" title={`Дополнительные: ${view.extras.map((r) => r.name).join(', ')}`}>+{view.extras.length}</span>}
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
        <Tabs label="Разделы" value={tab} onChange={setTab} tabs={[{ value: 'list', label: 'Список' }, { value: 'departments', label: 'Подразделения' }, ...(mayPositions ? [{ value: 'positions' as const, label: 'Должности' }] : [])]} />
      </SectionHead>
      {isOwner && usersList.some((employee: any) => employee.legacyBootstrap) && <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100" role="status">
        Начальный профиль администратора заблокирован. Откройте его карточку и перенесите на личный логин с новым паролем. ID, файлы и история сохранятся.
      </div>}
      {/* Фильтр со счётчиками — он же сводка: вопросы «кто отключён» и «у кого
          истекает» задают чаще, чем ищут человека по фамилии */}
      {batch && <DepartmentUndoBar message={batch.message} token={batch.token} onClose={() => setBatch(null)} onUndone={() => { setBatch(null); setChecked(new Set()); void loadUsers(); addToast('Перевод отменён', 'success'); }} />}
      {tab === 'positions' && mayPositions ? <PositionsTab positions={positions} users={usersList} addToast={addToast}
          onChanged={async () => { setRoles(await loadRoles(true)); }} />
      : tab === 'departments' ? <DepartmentsTab users={usersList} canManage={mayManage}
          onAssign={(userIds, target) => setAssign({ userIds, target })} onWizard={() => setWizardOpen(true)}
          onBatch={(message, token) => { if (token) setBatch({ message, token }); void loadUsers(); }} />
      : <>
      <Toolbar>
        <Btn tone="ghost" size="sm" aria-pressed={paneOpen} onClick={togglePane} title={paneOpen ? 'Скрыть дерево подразделений' : 'Показать дерево подразделений'}><PanelLeft />Подразделения</Btn>
        <label className="relative w-72 max-w-full">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Фамилия, логин, должность, подразделение" aria-label="Поиск сотрудника" className="pl-7" />
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
          { value: 'position', label: 'По должности' },
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
          <Empty title="Сотрудников пока нет" text="Заведите первого — он получит логин, должность и права доступа.">
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
                <th className="hidden @[720px]:table-cell">Должность</th>
                <th>Доступ</th>
                <th className="hidden @[560px]:table-cell">Подпись</th>
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
                      {/* Уровень доступа — отдельной отметкой, не должностью */}
                      {(emp.role === 'ADMIN' || emp.role === 'OWNER') && <Status tone="sky">{emp.role === 'OWNER' ? 'Владелец' : 'Администратор'}</Status>}
                      <span className="@[720px]:hidden text-slate-400 truncate">· {positionView(emp, roles).primary?.name || '—'}</span>
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
                  <td className="hidden @[720px]:table-cell whitespace-nowrap">{getPositionCell(emp)}</td>
                  <td className="whitespace-nowrap">{getAccessBadge(emp)}</td>
                  <td className="hidden @[560px]:table-cell whitespace-nowrap">
                    {/* Подпись видна прямо в строке: иначе, чтобы узнать, есть
                        ли она, надо открывать карточку каждого по очереди */}
                    <Chip tone={(emp as any).hasSignature ? 'emerald' : 'slate'} onClick={() => setSignFor(emp)}
                      title={(emp as any).hasSignature ? 'Подпись задана — открыть' : 'Подписи нет — задать'}>
                      {(emp as any).hasSignature ? 'есть' : 'нет'}
                    </Chip>
                  </td>
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
      {isRegisterOpen && <UserRegisterDialog positions={positions} departments={departments} initialDept={newDept} isOwner={isOwner}
        onClose={() => setIsRegisterOpen(false)} onCreated={loadUsers} addToast={addToast} />}
      {assign && <AssignDialog userIds={assign.userIds.length ? assign.userIds : [...checked]} departments={departments} initialTarget={assign.target} onClose={() => setAssign(null)}
        onDone={(message, token) => { setAssign(null); setChecked(new Set()); if (token) setBatch({ message, token }); void loadUsers(); }} />}
      {wizardOpen && <LegacyWizard departments={departments} rootId={rootId} onClose={() => setWizardOpen(false)}
        onDone={(message, token) => { setWizardOpen(false); if (token) setBatch({ message, token }); void loadUsers(); }} />}
      {isImportOpen && <EmployeeImportDialog roles={positions} onClose={() => setIsImportOpen(false)} onComplete={() => { void loadUsers(); }} />}

      {/* Карточка сотрудника: профиль, должности, срок, права */}
      {editUser && <UserAccessDialog key={editUser.id} user={editUser} positions={positions} departments={departments} isOwner={isOwner} mayManage={mayManage}
        onClose={() => setEditUser(null)} onChanged={loadUsers} addToast={addToast} />}
    </div>
  );
}
