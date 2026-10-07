// Настройки уведомлений — персональные, у каждого сотрудника свои.
//
// Хранятся на сервере (AppSetting, привязан к пользователю), а локально
// держится копия: интерфейсу настройки нужны мгновенно, до ответа сети, и
// программа должна работать, когда сервера нет. При входе копия
// подтягивается с сервера — так настройки едут за человеком на любой
// компьютер, а не заводятся заново на каждом рабочем месте.
//
// Список категорий ровно тот, что сервер действительно присылает:
// обещать в настройках то, что никогда не приходит, — обманывать человека.
// Сверено с сервером: категорий ниже шесть, и все приходят. Присылаются ещё
// две — «ПОЧТА» (server/mail/idle.ts, mailShared.ts) и «ОБРАЩЕНИЯ»
// (server/feedback/outbox.ts); отдельных строк у них нет, и они подчиняются
// только общим переключателям (неизвестная категория по умолчанию разрешена).

import { ENV_CONFIG, getAuthToken } from '../config/env';

export type NotifCategory = 'ЧАТ' | 'ДОКУМЕНТЫ' | 'ОБОРУДОВАНИЕ' | 'ПРОЕКТЫ' | 'ДОСТУП' | 'СИСТЕМА';

export const NOTIF_CATEGORIES: { id: NotifCategory; label: string; desc: string }[] = [
  { id: 'ЧАТ',          label: 'Сообщения',    desc: 'Личные сообщения в рабочем чате' },
  { id: 'ДОКУМЕНТЫ',    label: 'Документы',    desc: 'ВДР: документ готов, замечания заказчика, принят' },
  { id: 'ОБОРУДОВАНИЕ', label: 'Оборудование', desc: 'Конфликты ревизий после повторного импорта' },
  { id: 'ПРОЕКТЫ',      label: 'Проекты',      desc: 'Создан или удалён проект, вас добавили в проект' },
  { id: 'ДОСТУП',       label: 'Доступ',       desc: 'Изменены ваши права, просят доступ к вашему проекту' },
  { id: 'СИСТЕМА',      label: 'Система',      desc: 'Новая версия программы, приглашения на встречи' },
];

export interface NotifPrefs {
  popups: boolean;                 // показывать всплывашки справа
  sound: boolean;                  // звук уведомлений
  categories: Record<string, { show: boolean; sound: boolean }>;
}

export function defaultPrefs(): NotifPrefs {
  const categories: NotifPrefs['categories'] = {};
  for (const c of NOTIF_CATEGORIES) categories[c.id] = { show: true, sound: true };
  return { popups: true, sound: true, categories };
}

let currentUserId = '';
export function setNotifUser(userId: string | undefined | null) {
  currentUserId = userId || '';
  if (currentUserId) void pullPrefs();
}

const keyFor = (uid: string) => `notif_prefs_${uid || 'default'}`;

function normalize(parsed: any): NotifPrefs {
  const base = defaultPrefs();
  if (!parsed || typeof parsed !== 'object') return base;
  return {
    popups: parsed.popups !== false,
    sound: parsed.sound !== false,
    categories: { ...base.categories, ...(parsed.categories || {}) },
  };
}

export function getPrefs(): NotifPrefs {
  try {
    const raw = localStorage.getItem(keyFor(currentUserId));
    if (!raw) return defaultPrefs();
    return normalize(JSON.parse(raw));
  } catch {
    return defaultPrefs();
  }
}

function writeLocal(p: NotifPrefs) {
  try { localStorage.setItem(keyFor(currentUserId), JSON.stringify(p)); } catch {}
  try { window.dispatchEvent(new CustomEvent('notif-prefs-changed')); } catch {}
}

export function savePrefs(p: NotifPrefs) {
  writeLocal(p);
  void pushPrefs(p);
}

const authHeaders = (): Record<string, string> => {
  const t = getAuthToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
};

/** Забрать настройки с сервера — при входе на новом компьютере. */
export async function pullPrefs(): Promise<void> {
  if (!currentUserId) return;
  try {
    const res = await fetch(`${ENV_CONFIG.apiUrl}/notif-prefs`, { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.prefs) writeLocal(normalize(data.prefs));
  } catch (_) { /* нет связи — работаем на локальной копии */ }
}

async function pushPrefs(p: NotifPrefs): Promise<void> {
  if (!currentUserId) return;
  try {
    await fetch(`${ENV_CONFIG.apiUrl}/notif-prefs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ prefs: p }),
    });
  } catch (_) { /* останется локально и уйдёт при следующем сохранении */ }
}

/** Можно ли показать всплывашку этой категории. */
export function shouldPopup(category?: string): boolean {
  const p = getPrefs();
  if (!p.popups) return false;
  if (!category) return true;
  const c = p.categories[category];
  return c ? c.show : true;
}

/** Нужно ли звучать для этой категории. */
export function shouldSound(category?: string): boolean {
  const p = getPrefs();
  if (!p.sound) return false;
  if (!category) return true;
  const c = p.categories[category];
  return c ? c.sound : true;
}

/**
 * Что делать с локальной всплывашкой (toast) программы.
 *
 * Показ и звук решаются порознь. Ошибка показывается всегда: человек должен
 * узнать, что действие не удалось, как бы ни были настроены уведомления. А
 * звучит она, только если включён общий «Звук»: раньше ошибки пищали и при
 * выключенном звуке, и выключить их было нельзя.
 */
export function toastPlan(type: 'success' | 'error' | 'info', category?: string): { show: boolean; sound: boolean } {
  return { show: type === 'error' || shouldPopup(category), sound: shouldSound(category) };
}

/**
 * Короткий мягкий сигнал через WebAudio, без файлов.
 * Тон зависит от категории: сообщение в чате и замечание по документу
 * звучат по-разному, и на слух понятно, стоит ли отрываться от работы.
 */
let audioCtx: AudioContext | null = null;
const TONES: Record<string, [number, number]> = {
  'ЧАТ':          [660, 880],
  'ДОКУМЕНТЫ':    [520, 700],
  'ОБОРУДОВАНИЕ': [440, 560],
  'ПРОЕКТЫ':      [590, 740],
  'ДОСТУП':       [740, 560],   // нисходящий — что-то изменилось у вас
  'СИСТЕМА':      [500, 620],
};

export function playNotifSound(category?: string) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || (window as any).webkitAudioContext)();
    const ctx = audioCtx;
    const [from, to] = TONES[category || ''] || [660, 880];
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = 'sine';
    o.frequency.setValueAtTime(from, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(to, ctx.currentTime + 0.08);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    o.start(); o.stop(ctx.currentTime + 0.26);
  } catch {}
}
