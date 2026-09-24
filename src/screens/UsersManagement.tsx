import React, { useEffect, useState } from 'react';
import { useStore } from '../store/store';
import SignatureEditor from '../components/SignatureEditor';
import { useToastStore } from '../store/toastStore';
import { dataService, User } from '../services/dataService';
import { FEATURES, OPEN_BY_DEFAULT, entryOf, parsePermissions, PermMap } from '../lib/permissions';
import { Check } from 'lucide-react';
import NameFields, { NameValue, EMPTY_NAME } from '../components/NameFields';
import { Role, loadRoles, roleByCode, roleColorClass, isTopAdmin } from '../lib/roles';
import { usePresenceStore, presenceLabel } from '../store/presenceStore';
import PresencePanel from '../components/users/PresencePanel';
import PlayAccess, { type Mode as PlayMode } from '../components/users/PlayAccess';
import { cleanUserPermissions } from '../lib/userPermissions';
import { canManagePlay, canOpenApp } from '../lib/appPolicy';
import { useAppContext } from '../store/policyStore';
import { useNavigate } from 'react-router-dom';
import { fullNameOf } from '../lib/declension';
import RoleIcon from '../components/RoleIcon';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Users, 
  Plus, 
  X, 
  Lock, 
  ShieldCheck, 
  UserPlus, 
  Cpu, 
  Airplay, 
  UserCheck, 
  Calendar, 
  FileText,
  Clock,
  Briefcase,
  PenLine,
  Search
} from 'lucide-react';
import { useModalStore } from '../store/modalStore';
import { useEscapeClose } from '../lib/useDismiss';

// Диалоги программы вместо системных окон Windows
const { openConfirm } = useModalStore.getState();

export default function UsersManagement() {
  const { user } = useStore();
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

  // Escape закрывает открытое окно; пока идёт запись — не закрываем
  useEscapeClose(isModalOpen, () => { if (!isSubmitting) setIsModalOpen(false); });
  useEscapeClose(!!editUser, () => { if (!isSubmitting) setEditUser(null); });
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

  /**
   * Доступ к встроенным программам: три положения вместо двух.
   *
   * «По роли» — это стереть запись, а не записать `enabled: false`. Разница
   * не косметическая: отсутствие ключа значит «ничего не сказано», и ответ
   * ищется в правах роли, а `enabled: false` — это личный запрет, который
   * права роли перебивает.
   */
  const setPlayMode = (key: string, mode: PlayMode, until: string | null) => {
    setEditPerms((prev) => {
      const next = { ...prev };
      if (mode === 'INHERIT') { delete next[key]; return next; }
      next[key] = { enabled: mode === 'ALLOW', until, mode };
      return next;
    });
  };

  /**
   * Блок программ видит только тот, у кого самого есть к ним доступ.
   *
   * Иначе список игр прочитал бы любой администратор — а скрывать платформу
   * от сотрудника и показывать её в чужой карточке значит не скрывать вовсе.
   *
   * Одна оговорка, без которой платформу нельзя было бы включить ни разу:
   * главный администратор видит блок всегда. Первый доступ кому-то обязан
   * выдать человек, у которого этого доступа ещё нет, — иначе выдавать его
   * некому. Дальше правило работает как написано.
   */
  const policyCtx = useAppContext();
  const navigate = useNavigate();
  const showsPlay = canOpenApp(policyCtx) || canManagePlay(policyCtx) || isTopAdmin(user as any, roles);

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

  const openEdit = (emp: User) => {
    setEditUser(emp);
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
    if (!editUser) return;
    setEditError('');
    setIsEditSubmitting(true);
    if (!editSymbol.trim()) { setEditError('Укажите табельный номер (логин)'); setIsEditSubmitting(false); return; }
    const cleanPerms = cleanUserPermissions(editPerms);
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
    if (!editUser) return;
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

  // Бейдж статуса доступа: активен / отключен / истекает / истек
  const getAccessBadge = (emp: User) => {
    if (emp.isActive === false) {
      return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-400 border border-rose-200 dark:border-rose-900/50">Отключен</span>;
    }
    if (emp.validUntil) {
      const until = new Date(emp.validUntil);
      const expired = until.getTime() < Date.now();
      const dateStr = until.toLocaleDateString('ru-RU');
      if (expired) {
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-400 border border-rose-200 dark:border-rose-900/50">Истек {dateStr}</span>;
      }
      return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap bg-amber-50 dark:bg-amber-950/20 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800/40"><Clock className="w-3 h-3 shrink-0" />до {dateStr}</span>;
    }
    return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap bg-emerald-50 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/40">Активен</span>;
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
  }, []);

  // 2. Validate and handle user registration
  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
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
        validUntil: validUntil ? new Date(`${validUntil}T23:59:59`).toISOString() : null
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
      if (!needle) return true;
      // Ищем и по роли: «покажи всех КИПиА» — обычный вопрос к этому списку
      const role = roleByCode(e.role, roles).name || e.role || '';
      return `${e.name} ${e.symbol} ${role}`.toLowerCase().includes(needle);
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
  }, [usersList, q, pick, sortBy, roles]);

  /** Инициалы для кружка в строке — «Раупов Хусрав» → «РХ» */
  const initialsOf = (emp: User) => {
    const parts = String(emp.name || emp.symbol || '').trim().split(/\s+/).filter(Boolean);
    return (parts.slice(0, 2).map((x) => x[0]).join('') || '?').toUpperCase();
  };

  const getRoleBadge = (userRole: string) => {
    const r = roleByCode(userRole, roles);
    return (
      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${roleColorClass(r.color)}`}>
        <RoleIcon name={r.icon} className="w-3.5 h-3.5" />
        {r.name}
        {r.level <= 1 && <span className="text-2xs opacity-70">· 1 уровень</span>}
      </span>
    );
  };

  return (
    <motion.div 
      id="users-management-root"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.2 }}
      className="@container pb-6"
    >
      {/* Штамп раздела — как у остальных разделов программы */}
      <div className="stamp rounded-t-xl border border-slate-200 dark:border-dark-border border-b-0">
        <Users className="w-4 h-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <span className="stamp-title">Сотрудники</span>
        <span className="stamp-sub hidden @[560px]:inline">права доступа, роли, подписи</span>
        <div className="stamp-right">
          <button
            type="button"
            onClick={() => setIsModalOpen(true)}
            title="Добавить сотрудника"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white rounded-lg text-xs font-bold transition-ui cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5 shrink-0" />
            <span className="hidden @[520px]:inline">Добавить сотрудника</span>
          </button>
        </div>
      </div>

      {/* Полоса счётчиков. Она же быстрый отбор: вопросы «кто отключён» и
          «у кого истекает» задают чаще, чем ищут человека по фамилии. */}
      <div className="tally border-x border-slate-200 dark:border-dark-border">
        {([
          { id: 'all', n: counts.total, label: 'всего' },
          { id: 'active', n: counts.active, label: 'работают' },
          { id: 'off', n: counts.off, label: 'закрыт доступ' },
          { id: 'soon', n: counts.soon, label: 'истекает' },
          { id: 'nosign', n: counts.nosign, label: 'без подписи' },
        ] as const).map((c) => (
          <button
            key={c.id}
            type="button"
            aria-pressed={pick === c.id}
            onClick={() => setPick(pick === c.id && c.id !== 'all' ? 'all' : c.id)}
            title={c.id === 'all' ? 'Показать всех' : `Показать: ${c.label}`}
            className="tally-item cursor-pointer"
          >
            <span className="tally-num">{c.n}</span>
            <span className="tally-lab truncate">{c.label}</span>
          </button>
        ))}
      </div>

      {/* Кто здесь сейчас и кто когда заходил. Отдельным блоком, а не колонкой
          в таблице: это вопрос о людях вообще, а не о конкретной строке, и
          задаётся он раньше, чем начинают искать человека по фамилии. */}
      <PresencePanel people={usersList as any} />

      {/* Поиск и порядок */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-x border-b border-slate-200 dark:border-dark-border bg-white dark:bg-dark-surface">
        <div className="flex-1 min-w-[160px] flex items-center gap-2 h-8 px-2.5 rounded-lg border border-slate-200 dark:border-dark-border bg-slate-50 dark:bg-dark-panel">
          <Search className="w-3.5 h-3.5 shrink-0 text-slate-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Фамилия, логин или роль"
            aria-label="Поиск сотрудника"
            className="flux-focus-outer flex-1 min-w-0 bg-transparent text-xs outline-none text-slate-800 dark:text-dark-text-main placeholder:text-slate-400"
          />
          {q && (
            <button type="button" onClick={() => setQ('')} title="Очистить поиск"
              className="w-5 h-5 shrink-0 rounded flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="graf hidden @[640px]:inline">Порядок</span>
          {([
            { id: 'name', label: 'По фамилии' },
            { id: 'role', label: 'По роли' },
            { id: 'created', label: 'Сначала новые' },
          ] as const).map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => setSortBy(o.id)}
              aria-pressed={sortBy === o.id}
              className={`px-2.5 py-1 min-h-6 rounded-md text-2xs font-semibold transition-ui cursor-pointer ${
                sortBy === o.id
                  ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-800 dark:text-emerald-300'
                  : 'text-slate-500 dark:text-dark-text-muted hover:bg-slate-100 dark:hover:bg-dark-panel'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {/* Список сотрудников */}
      <div className="border-x border-b border-slate-200 dark:border-dark-border rounded-b-xl bg-white dark:bg-dark-surface overflow-hidden">
        {isLoading ? (
          <div className="py-16 text-center text-slate-500">
            <div className="w-8 h-8 rounded-full border-2 border-emerald-500 border-t-transparent animate-spin mx-auto mb-3" />
            <p className="text-sm">Загружаю список сотрудников…</p>
          </div>
        ) : usersList.length === 0 ? (
          <div className="blank">
            <div className="blank-title">Сотрудников пока нет</div>
            <div className="blank-text">
              Заведите первого — он получит логин, роль и права доступа. Пароль можно
              задать сразу или выдать позже.
            </div>
            <button type="button" onClick={() => setIsModalOpen(true)}
              className="mt-2 px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold cursor-pointer transition-ui">
              Добавить сотрудника
            </button>
          </div>
        ) : shown.length === 0 ? (
          <div className="blank">
            <div className="blank-title">Никто не подходит под отбор</div>
            <div className="blank-text">Снимите фильтр в полосе счётчиков или очистите поиск.</div>
            <button type="button" onClick={() => { setQ(''); setPick('all'); }}
              className="mt-2 px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold cursor-pointer transition-ui">
              Показать всех
            </button>
          </div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-dark-border bg-slate-50/60 dark:bg-dark-panel/40">
                <th className="flux-cell graf text-left">Сотрудник</th>
                <th className="flux-cell graf text-left hidden @[720px]:table-cell">Роль</th>
                <th className="flux-cell graf text-left">Доступ</th>
                <th className="flux-cell graf text-left hidden @[560px]:table-cell">Подпись</th>
                <th className="flux-cell graf text-left hidden @[980px]:table-cell">Заведён</th>
                <th className="flux-cell graf text-right"> </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-150 dark:divide-slate-850">
              {shown.map((emp) => (
                <tr
                  key={emp.id}
                  onDoubleClick={() => openEdit(emp)}
                  title="Двойное нажатие — открыть карточку сотрудника"
                  className="hover:bg-slate-50 dark:hover:bg-dark-panel/50 transition-colors text-slate-800 dark:text-dark-text-main cursor-default"
                >
                  {/* Человек: кружок с инициалами, ФИО, под ним логин — логин
                      нужен всегда, а отдельная колонка под него есть не на
                      каждой ширине */}
                  <td className="flux-cell w-full max-w-0">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="relative shrink-0">
                        <span className="w-8 h-8 flex rounded-full items-center justify-center text-2xs font-extrabold bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border border-emerald-200/60 dark:border-emerald-900/50">
                          {initialsOf(emp)}
                        </span>
                        {/* «В сети» — то же самое, что в чате, и по тому же
                            правилу: администратор виден наравне со всеми */}
                        {onlineIds.includes(emp.id) && (
                          <span
                            aria-label="В сети"
                            title={presenceLabel(true, null)}
                            className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-500
                                       border-2 border-white dark:border-dark-surface"
                          />
                        )}
                      </span>
                      <span className="min-w-0">
                        <span className="block font-semibold text-slate-900 dark:text-white truncate" title={emp.name}>
                          {emp.name}
                        </span>
                        <span className="block data text-2xs text-emerald-700 dark:text-emerald-400 truncate">
                          {emp.symbol}
                          <span className="@[720px]:hidden text-slate-400 dark:text-dark-text-muted">
                            {' · '}{roleByCode(emp.role, roles).name}
                          </span>
                        </span>
                      </span>
                    </div>
                  </td>
                  <td className="flux-cell hidden @[720px]:table-cell whitespace-nowrap">{getRoleBadge(emp.role)}</td>
                  <td className="flux-cell whitespace-nowrap">{getAccessBadge(emp)}</td>
                  <td className="flux-cell hidden @[560px]:table-cell whitespace-nowrap">
                    {/* Подпись видна прямо в строке: иначе, чтобы узнать, есть
                        ли она, надо открывать карточку каждого по очереди */}
                    <button
                      type="button"
                      onClick={() => setSignFor(emp)}
                      title={(emp as any).hasSignature ? 'Подпись задана — открыть' : 'Подписи нет — задать'}
                      className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg border text-2xs font-semibold cursor-pointer transition-ui ${
                        (emp as any).hasSignature
                          ? 'border-emerald-200 dark:border-emerald-900/50 text-emerald-700 dark:text-emerald-400 bg-emerald-50/60 dark:bg-emerald-950/30 hover:bg-emerald-50 dark:hover:bg-emerald-950/50'
                          : 'border-slate-200 dark:border-dark-border text-slate-400 hover:bg-slate-100 dark:hover:bg-dark-panel'
                      }`}
                    >
                      <PenLine className="w-3.5 h-3.5 shrink-0" />
                      {(emp as any).hasSignature ? 'есть' : 'нет'}
                    </button>
                  </td>
                  <td className="flux-cell hidden @[980px]:table-cell data text-2xs text-slate-400 whitespace-nowrap">
                    {new Date(emp.createdAt || Date.now()).toLocaleDateString('ru-RU')}
                  </td>
                  <td className="flux-cell text-right whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => openEdit(emp)}
                      title={`Карточка сотрудника: ${emp.name}`}
                      className="px-3 py-1.5 text-2xs font-semibold rounded-lg border border-slate-200 dark:border-dark-border text-slate-600 dark:text-dark-text-main hover:bg-slate-100 dark:hover:bg-dark-panel transition-ui cursor-pointer whitespace-nowrap"
                    >
                      Изменить
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Подпись сотрудника — своё окно, вне AnimatePresence */}
      {signFor && (
        <SignatureEditor
          userId={signFor.id}
          userName={signFor.name || signFor.symbol}
          nameParts={{ lastName: signFor.lastName, firstName: signFor.firstName, middleName: signFor.middleName, name: signFor.name }}
          value={signFor.hasSignature ? 'есть' : null}
          heightMm={signFor.signatureHeightMm ?? 8}
          canEdit={user?.id === signFor.id || user?.role === 'ADMIN'}
          onSaved={(sig, mm) => setUsersList((prev) => prev.map((u: any) =>
            u.id === signFor.id ? { ...u, hasSignature: !!sig, signatureHeightMm: mm } : u))}
          onClose={() => setSignFor(null)}
        />
      )}

      {/* Модальное окно добавления нового пользователя */}
      <AnimatePresence>
      {isModalOpen && (
          <div className="fixed inset-0 z-50 overflow-y-auto" role="dialog" aria-modal="true">
            {/* Overlay */}
            <div className="fixed inset-0 bg-slate-950/55 backdrop-blur-md transition-opacity" onClick={() => !isSubmitting && setIsModalOpen(false)} />

            {/* Container for centering */}
            <div className="flex min-h-full items-center justify-center p-4">
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 10 }}
                transition={{ duration: 0.15 }}
                className="relative w-full max-w-md transform rounded-xl bg-white dark:bg-slate-900 p-6 shadow-xl border border-slate-200 dark:border-slate-800 transition-colors"
              >
                {/* Header */}
                <div className="flex items-center justify-between mb-5 border-b border-slate-100 dark:border-slate-800 pb-3">
                  <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
                    <UserPlus className="w-5 h-5" />
                    <h3 className="text-lg font-bold text-slate-900 dark:text-white">
                      Регистрация сотрудника
                    </h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsModalOpen(false)}
                    disabled={isSubmitting}
                    className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-650 dark:hover:text-white transition-colors cursor-pointer"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                {/* Form Error Feedback */}
                {formError && (
                  <div className="p-3 mb-4 rounded bg-rose-50 dark:bg-rose-950/20 text-rose-700 dark:text-rose-450 text-xs font-medium border border-rose-200 dark:border-rose-900">
                    {formError}
                  </div>
                )}

                {/* Form */}
                <form onSubmit={handleCreateUser} className="space-y-4">
                  <NameFields value={nameValue} onChange={setNameValue} disabled={isSubmitting} />

                  <div>
                    <label className="block text-xs font-semibold text-slate-550 dark:text-slate-400 uppercase tracking-widest mb-1 font-mono">
                      Табельный номер (ID)
                    </label>
                    <input
                      type="text"
                      required
                      value={symbol}
                      onChange={(e) => setSymbol(e.target.value)}
                      disabled={isSubmitting}
                      className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-sm text-slate-800 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-ui font-mono"
                      placeholder="Например, 4519"
                    />
                    <p className="text-xs text-slate-400 mt-1 dark:text-slate-500">
                      Используется как логин для входа. Не может содержать символ @ и должен быть уникальным.
                    </p>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-550 dark:text-slate-400 uppercase tracking-widest mb-1">
                      Пароль доступа в систему
                    </label>
                    <input
                      type="text"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      disabled={isSubmitting}
                      className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-sm text-slate-800 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-ui"
                      placeholder="Задайте надежный пароль"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-550 dark:text-slate-400 uppercase tracking-widest mb-1">
                      Роль в системе
                    </label>
                    <select
                      value={role}
                      onChange={(e) => setRole(e.target.value)}
                      disabled={isSubmitting}
                      className="w-full h-[38px] px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-sm text-slate-850 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-ui cursor-pointer"
                    >
                      {roles.map((r) => (
                        <option key={r.code} value={r.code}>{r.name}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-550 dark:text-slate-400 uppercase tracking-widest mb-1">
                      Срок действия профиля (опционально)
                    </label>
                    <input
                      type="date"
                      value={validUntil}
                      onChange={(e) => setValidUntil(e.target.value)}
                      disabled={isSubmitting}
                      className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-sm text-slate-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-ui"
                    />
                    <p className="text-xs text-slate-400 mt-1 dark:text-slate-500">
                      После этой даты сотрудник не сможет войти в систему. Пусто — бессрочный доступ.
                    </p>
                  </div>

                  <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100 dark:border-slate-800 mt-5">
                    <button
                      type="button"
                      disabled={isSubmitting}
                      onClick={() => setIsModalOpen(false)}
                      className="px-4 py-2 text-slate-650 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-850 rounded-lg text-sm font-semibold transition-colors cursor-pointer"
                    >
                      Отмена
                    </button>
                    <button
                      type="submit"
                      disabled={isSubmitting}
                      className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 active:bg-emerald-800 text-white rounded-lg text-sm font-semibold shadow-md transition-colors cursor-pointer flex items-center gap-1.5"
                    >
                      {isSubmitting ? (
                        <>
                          <div className="w-3.5 h-3.5 rounded-full border-2 border-white border-t-transparent animate-spin" />
                          <span>Создание...</span>
                        </>
                      ) : (
                        <span>Зарегистрировать</span>
                      )}
                    </button>
                  </div>
                </form>
              </motion.div>
            </div>
          </div>
        )}
      </AnimatePresence>

      {/* Модальное окно управления профилем сотрудника */}
      <AnimatePresence>
        {editUser && (
          <div className="fixed inset-0 z-50 overflow-y-auto" role="dialog" aria-modal="true">
            <div className="fixed inset-0 bg-slate-950/55 backdrop-blur-md transition-opacity" onClick={() => !isEditSubmitting && setEditUser(null)} />
            <div className="flex min-h-full items-center justify-center p-4">
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 10 }}
                transition={{ duration: 0.15 }}
                className="relative w-full max-w-md transform rounded-xl bg-white dark:bg-slate-900 p-6 shadow-xl border border-slate-200 dark:border-slate-800 transition-colors"
              >
                <div className="flex items-center justify-between mb-5 border-b border-slate-100 dark:border-slate-800 pb-3">
                  <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
                    <ShieldCheck className="w-5 h-5" />
                    <h3 className="text-lg font-bold text-slate-900 dark:text-white">
                      Управление доступом
                    </h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditUser(null)}
                    disabled={isEditSubmitting}
                    className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-650 dark:hover:text-white transition-colors cursor-pointer"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
                  Сотрудник: <span className="font-semibold text-slate-800 dark:text-white">{editUser.name}</span>
                  {' '}<span className="font-mono text-emerald-700 dark:text-emerald-400">({editUser.symbol})</span>
                </p>

                {editError && (
                  <div className="p-3 mb-4 rounded bg-rose-50 dark:bg-rose-950/20 text-rose-700 dark:text-rose-450 text-xs font-medium border border-rose-200 dark:border-rose-900">
                    {editError}
                  </div>
                )}

                <form onSubmit={handleSaveEdit} className="space-y-4">
                  <NameFields value={editNameValue} onChange={setEditNameValue} disabled={isEditSubmitting} />

                  <div>
                    <label className="block text-xs font-semibold text-slate-550 dark:text-slate-400 uppercase tracking-widest mb-1 font-mono">Табельный номер (логин)</label>
                    <input
                      type="text"
                      value={editSymbol}
                      onChange={(e) => setEditSymbol(e.target.value)}
                      disabled={isEditSubmitting}
                      className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-sm text-slate-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-ui font-mono"
                    />
                    <p className="text-xs text-slate-400 mt-1 dark:text-slate-500">Логин для входа. Должен быть уникальным, без символа @.</p>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-550 dark:text-slate-400 uppercase tracking-widest mb-1">Роль</label>
                      <select
                        value={editRole}
                        onChange={(e) => setEditRole(e.target.value)}
                        disabled={isEditSubmitting}
                        className="w-full h-[38px] px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-sm text-slate-850 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-ui cursor-pointer"
                      >
                        {roles.map((r) => (
                          <option key={r.code} value={r.code}>{r.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-550 dark:text-slate-400 uppercase tracking-widest mb-1">Новый пароль</label>
                      <input
                        type="text"
                        value={editPassword}
                        onChange={(e) => setEditPassword(e.target.value)}
                        disabled={isEditSubmitting}
                        placeholder="Не менять"
                        className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-sm text-slate-800 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-ui"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-550 dark:text-slate-400 uppercase tracking-widest mb-1">
                      Доступ действует до
                    </label>
                    <input
                      type="date"
                      value={editValidUntil}
                      onChange={(e) => setEditValidUntil(e.target.value)}
                      disabled={isEditSubmitting}
                      className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-sm text-slate-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-ui"
                    />
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      <button type="button" disabled={isEditSubmitting} onClick={() => setEditValidUntil(presetDate(30))} className="px-2 py-1 text-xs font-semibold rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer">+30 дней</button>
                      <button type="button" disabled={isEditSubmitting} onClick={() => setEditValidUntil(presetDate(90))} className="px-2 py-1 text-xs font-semibold rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer">+90 дней</button>
                      <button type="button" disabled={isEditSubmitting} onClick={() => setEditValidUntil(presetDate(365))} className="px-2 py-1 text-xs font-semibold rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer">+1 год</button>
                      <button type="button" disabled={isEditSubmitting} onClick={() => setEditValidUntil('')} className="px-2 py-1 text-xs font-semibold rounded border border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 transition-colors cursor-pointer">Бессрочно</button>
                    </div>
                  </div>

                  <label className="flex items-center gap-2.5 p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={editActive}
                      onChange={(e) => setEditActive(e.target.checked)}
                      disabled={isEditSubmitting}
                      className="w-4 h-4 accent-emerald-600 cursor-pointer"
                    />
                    <span className="text-sm font-semibold text-slate-800 dark:text-white">Профиль активен</span>
                    <span className="text-xs text-slate-400 dark:text-slate-500">(снимите, чтобы мгновенно заблокировать вход)</span>
                  </label>

                  {/* Права доступа по функциям */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-550 dark:text-slate-400 uppercase tracking-widest mb-2">Права доступа</label>
                    {editRole === 'ADMIN' ? (
                      <div className="flex items-center gap-2 p-3 rounded-lg border border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/20 text-rose-700 dark:text-rose-400 text-sm font-semibold">
                        <ShieldCheck className="w-4 h-4" /> Полный доступ (администратор)
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        {FEATURES.map((f) => {
                          const e = editPerms[f.id];
                          // Право, открытое по умолчанию, галочка показывает таким, каким
                          // оно действует (роль, умолчание, личное); снятие пишет запрет
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
                            <div key={f.id} className={`rounded-lg border p-2.5 transition-colors ${on ? 'border-emerald-300 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/20' : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950'}`}>
                              <label className="flex items-start gap-2.5 cursor-pointer select-none">
                                <input
                                  type="checkbox"
                                  checked={on}
                                  onChange={(ev) => togglePerm(f.id, ev.target.checked)}
                                  disabled={isEditSubmitting}
                                  className="w-4 h-4 mt-0.5 accent-emerald-600 cursor-pointer shrink-0"
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-sm font-semibold text-slate-800 dark:text-white">{f.label}</span>
                                    <span className="text-2xs font-mono text-slate-400">{f.group}</span>
                                    {fromRole && !on && (
                                      <span className="text-2xs px-1.5 py-0.5 rounded-full bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-400 font-semibold border border-sky-200 dark:border-sky-900/60">
                                        уже даёт роль
                                      </span>
                                    )}
                                    {f.risky && <span className="text-2xs font-bold text-amber-600 dark:text-amber-400">осторожно</span>}
                                    {open && !e && on && <span className="text-2xs text-slate-400">у всех по умолчанию — снимите, чтобы запретить</span>}
                                    {open && e && !e.enabled && <span className="text-2xs font-semibold text-rose-600 dark:text-rose-400">запрещено лично</span>}
                                    {on && isExpired && <span className="text-xs px-1.5 py-0.5 rounded-full bg-rose-100 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400 font-semibold">истекло</span>}
                                  </div>
                                  <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">{f.desc}</p>
                                </div>
                              </label>
                              {on && (
                                <div className="mt-2 pl-7 flex items-center gap-2 flex-wrap">
                                  <span className="text-xs text-slate-500 dark:text-slate-400">действует до:</span>
                                  <input
                                    type="datetime-local"
                                    value={toDateTimeInput(e?.until)}
                                    onChange={(ev) => setPermUntil(f.id, ev.target.value)}
                                    disabled={isEditSubmitting}
                                    className="px-2 py-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded text-xs text-slate-800 dark:text-white focus:outline-none focus:border-emerald-500"
                                  />
                                  {e?.until
                                    ? <button type="button" onClick={() => setPermUntil(f.id, '')} className="text-xs text-emerald-700 dark:text-emerald-400 hover:underline cursor-pointer">бессрочно</button>
                                    : <span className="text-xs text-slate-400">бессрочно</span>}
                                </div>
                              )}
                            </div>
                          );
                        })}
                        <p className="text-xs text-slate-400 dark:text-slate-500 mt-1.5">Администратор всегда имеет полный доступ независимо от этих галочек.</p>
                      </div>
                    )}
                  </div>

                  {showsPlay && (
                    <PlayAccess
                      perms={editPerms}
                      rolePerms={parsePermissions((editUser as any)?.rolePermissions)}
                      disabled={isEditSubmitting}
                      onSet={setPlayMode}
                      platformOn={policyCtx.platform.supported ? policyCtx.platform.enabled : undefined}
                      onOpenSettings={canManagePlay(policyCtx) || isTopAdmin(user as any, roles)
                        ? () => navigate('/settings?section=play') : undefined}
                    />
                  )}

                  <div className="flex items-center justify-between gap-3 pt-4 border-t border-slate-100 dark:border-slate-800 mt-5">
                    <button
                      type="button"
                      disabled={isEditSubmitting}
                      onClick={handleDeleteUser}
                      className="px-3 py-2 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 rounded-lg text-sm font-semibold transition-colors cursor-pointer"
                    >
                      Удалить профиль
                    </button>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        disabled={isEditSubmitting}
                        onClick={() => setEditUser(null)}
                        className="px-4 py-2 text-slate-650 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-850 rounded-lg text-sm font-semibold transition-colors cursor-pointer"
                      >
                        Отмена
                      </button>
                      <button
                        type="submit"
                        disabled={isEditSubmitting}
                        className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 active:bg-emerald-800 text-white rounded-lg text-sm font-semibold shadow-md transition-colors cursor-pointer"
                      >
                        {isEditSubmitting ? 'Сохранение...' : 'Сохранить'}
                      </button>
                    </div>
                  </div>
                </form>
              </motion.div>
            </div>
          </div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
