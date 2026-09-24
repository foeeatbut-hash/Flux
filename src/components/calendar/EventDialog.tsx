/**
 * Окно события: назначить встречу, поставить памятку, позвать людей.
 *
 * Одно окно на всё — и на создание, и на правку, и на то, что пришло из письма
 * или от помощника уже заполненным. Второе окно «для быстрого создания»
 * означало бы два места, где заводят одно и то же, и они разошлись бы по полям
 * в первый же месяц.
 *
 * Срок ВДР сюда не попадает: его правят в реестре. Окно об этом прямо говорит,
 * а не показывает поля, которые ничего не изменят.
 */
import React from 'react';
import { X, Trash2, Link2, Users, Bell, Repeat, Lock, TriangleAlert } from 'lucide-react';
import { useStore } from '../../store/store';
import { useCalendarStore } from '../../store/calendarStore';
import { useToastStore } from '../../store/toastStore';
import { openLink } from '../../lib/openLink';
import { Z } from '../../lib/layers';
import {
  buildRule, parseRule, ruleLabel, isReadOnly, MINUTE, WEEKDAYS,
  type CalEvent,
} from '../../lib/calendar';

/** Черновик события: то, что показывают поля до сохранения */
export interface Draft {
  id?: string;
  kind?: CalEvent['kind'];
  title?: string;
  description?: string;
  startsAt: number;
  endsAt: number;
  allDay?: boolean;
  rrule?: string;
  place?: string;
  joinUrl?: string;
  remindMin?: number;
  visibility?: CalEvent['visibility'];
  guests?: string[];
  source?: CalEvent['source'];
  sourceId?: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const toLocal = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocal = (v: string, fallback: number): number => {
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : fallback;
};

const REMIND = [0, 5, 15, 30, 60, 24 * 60];
const remindLabel = (m: number): string => {
  if (!m) return 'не напоминать';
  if (m < 60) return `за ${m} мин.`;
  if (m === 60) return 'за час';
  return 'за сутки';
};

export default function EventDialog({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const me = useStore((s) => s.user);
  const save = useCalendarStore((s) => s.save);
  const remove = useCalendarStore((s) => s.remove);
  const events = useCalendarStore((s) => s.events);
  const { addToast } = useToastStore();

  const existing = draft.id ? events.find((e) => e.id === draft.id) || null : null;
  const readOnly = !!existing && isReadOnly(existing);

  const [form, setForm] = React.useState<Draft>({
    kind: 'meeting', title: '', description: '', allDay: false, rrule: '',
    place: '', joinUrl: '', remindMin: 5, visibility: 'project', guests: [],
    ...draft,
  });
  const [people, setPeople] = React.useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = React.useState(false);

  // Звать можно только тех, кто есть в программе: список приходит с сервера
  React.useEffect(() => {
    let alive = true;
    // Токен добавляет общая обёртка fetch (src/config/env.ts), и подставлять
    // его руками нельзя: здесь стояло неверное имя ключа хранилища, заголовок
    // уходил пустым, сервер отвечал «требуется вход» — и программа выкидывала
    // человека на экран входа ровно в тот момент, когда он открывал событие
    // календаря. Своим заголовком мы ещё и запрещали обёртке подставить верный
    fetch('/api/users')
      .then((r) => (r.ok ? r.json() : []))
      .then((list: any) => {
        if (!alive) return;
        const rows = Array.isArray(list) ? list : list?.users || [];
        setPeople(rows.map((u: any) => ({ id: u.id, name: u.name })).filter((u: any) => u.id !== me?.id));
      })
      .catch(() => { /* без списка людей встречу всё равно можно назначить */ });
    return () => { alive = false; };
  }, [me?.id]);

  const set = (patch: Partial<Draft>) => setForm((f) => ({ ...f, ...patch }));

  const rule = parseRule(form.rrule || '');
  const weekly = rule?.freq === 'WEEKLY';

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    const saved = await save(form as any);
    setBusy(false);
    if (!saved) { addToast('Не удалось сохранить событие', 'error'); return; }
    addToast(draft.id ? 'Событие изменено' : 'Событие в календаре', 'success');
    onClose();
  };

  const drop = async () => {
    if (!form.id) return;
    const ok = await remove(form.id);
    if (!ok) { addToast('Не удалось удалить', 'error'); return; }
    addToast('Событие удалено', 'success');
    onClose();
  };

  const field = `w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg
                 px-3 py-2 text-sm text-slate-800 dark:text-slate-150 outline-none focus:border-emerald-400`;
  const label = 'block text-2xs font-semibold text-slate-500 dark:text-slate-400 mb-1';

  return (
    <div
      className="fixed inset-0 flex items-center justify-center backdrop-blur-[1px] p-4 fx-backdrop"
      style={{ zIndex: Z.modal }}
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-label={draft.id ? 'Событие' : 'Новое событие'}
        onMouseDown={(e) => e.stopPropagation()}
        className="fx-dialog w-full max-w-lg max-h-[86vh] overflow-y-auto dark:border-dark-border dark:bg-dark-surface"
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 dark:border-dark-border">
          <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            {readOnly ? 'Срок из реестра ВДР' : draft.id ? 'Событие' : 'Новое событие'}
          </span>
          <span className="flex-1" />
          <button type="button" onClick={onClose} aria-label="Закрыть"
            className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-850">
            <X className="w-4 h-4" />
          </button>
        </div>

        {readOnly ? (
          <div className="p-4 space-y-3">
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{existing?.title}</p>
            <div className="flex items-start gap-2 rounded-lg p-3 bg-amber-50 dark:bg-amber-950/20
                            border border-amber-200 dark:border-amber-900/50">
              <TriangleAlert className="w-4 h-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
              <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                Срок живёт в реестре ВДР, а календарь только показывает его. Двигать его отсюда нельзя:
                иначе о сроке появилось бы два мнения — реестра и календаря.
              </p>
            </div>
            <button type="button" onClick={() => { onClose(); window.location.hash = ''; }}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 text-white cursor-pointer hover:bg-emerald-700">
              Открыть в Менеджменте
            </button>
          </div>
        ) : (
          <div className="p-4 space-y-3">
            <label className="block">
              <span className={label}>Название</span>
              <input autoFocus value={form.title || ''} onChange={(e) => set({ title: e.target.value })}
                placeholder="Планёрка по АВО-2" className={field} />
            </label>

            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className={label}>Начало</span>
                <input type="datetime-local" value={toLocal(form.startsAt)}
                  onChange={(e) => {
                    const startsAt = fromLocal(e.target.value, form.startsAt);
                    // Конец едет за началом: перенос встречи не должен
                    // молча превращать получас в минус два часа
                    const length = Math.max(15 * MINUTE, form.endsAt - form.startsAt);
                    set({ startsAt, endsAt: startsAt + length });
                  }}
                  className={field} />
              </label>
              <label className="block">
                <span className={label}>Конец</span>
                <input type="datetime-local" value={toLocal(form.endsAt)}
                  onChange={(e) => set({ endsAt: fromLocal(e.target.value, form.endsAt) })}
                  className={field} />
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="flex items-center gap-1.5 text-2xs text-slate-500 dark:text-slate-400">
                <Repeat className="w-3.5 h-3.5" /> Повтор
              </span>
              {[
                { id: '', label: 'не повторять' },
                { id: 'FREQ=DAILY', label: 'каждый день' },
                { id: buildRule({ freq: 'WEEKLY', byDay: [new Date(form.startsAt).getDay() === 0 ? 6 : new Date(form.startsAt).getDay() - 1] }), label: 'каждую неделю' },
                { id: 'FREQ=MONTHLY', label: 'каждый месяц' },
              ].map((r) => (
                <button key={r.label} type="button" onClick={() => set({ rrule: r.id })}
                  className={`px-2 py-1 rounded-lg text-2xs font-semibold cursor-pointer ${
                    (form.rrule || '') === r.id
                      ? 'bg-emerald-600 text-white'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-850'}`}>
                  {r.label}
                </button>
              ))}
            </div>

            {weekly && (
              <div className="flex items-center gap-1">
                {WEEKDAYS.map((d, i) => {
                  const on = rule!.byDay.includes(i);
                  return (
                    <button key={d} type="button"
                      onClick={() => {
                        const byDay = on ? rule!.byDay.filter((x) => x !== i) : [...rule!.byDay, i].sort();
                        set({ rrule: buildRule({ freq: 'WEEKLY', interval: rule!.interval, byDay }) });
                      }}
                      className={`w-8 h-7 rounded-lg text-2xs font-semibold cursor-pointer ${
                        on ? 'bg-emerald-600 text-white' : 'bg-slate-100 dark:bg-slate-850 text-slate-500'}`}>
                      {d}
                    </button>
                  );
                })}
                <span className="ml-2 text-2xs text-slate-400">{ruleLabel(form.rrule || '')}</span>
              </div>
            )}

            <label className="block">
              <span className={label}>Ссылка на встречу</span>
              <div className="flex items-center gap-2">
                <input value={form.joinUrl || ''} onChange={(e) => set({ joinUrl: e.target.value })}
                  placeholder="https://link.mts.ru/j/8821" className={field} />
                {!!form.joinUrl && (
                  <button type="button" onClick={() => openLink(form.joinUrl!)} title="Проверить ссылку"
                    className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center cursor-pointer
                               text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-850">
                    <Link2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </label>

            <div>
              <span className={label}><Users className="w-3 h-3 inline mr-1" />Участники</span>
              <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                {people.length === 0 && <span className="text-2xs text-slate-400">Других сотрудников пока нет.</span>}
                {people.map((p) => {
                  const on = (form.guests || []).includes(p.id);
                  return (
                    <button key={p.id} type="button"
                      onClick={() => set({
                        guests: on ? (form.guests || []).filter((g) => g !== p.id) : [...(form.guests || []), p.id],
                      })}
                      className={`px-2 py-1 rounded-lg text-2xs font-semibold cursor-pointer ${
                        on ? 'bg-emerald-600 text-white' : 'bg-slate-100 dark:bg-slate-850 text-slate-600 dark:text-slate-300'}`}>
                      {p.name}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="flex items-center gap-1.5 text-2xs text-slate-500 dark:text-slate-400">
                <Bell className="w-3.5 h-3.5" /> Напомнить
              </span>
              {REMIND.map((m) => (
                <button key={m} type="button" onClick={() => set({ remindMin: m })}
                  className={`px-2 py-1 rounded-lg text-2xs font-semibold cursor-pointer ${
                    (form.remindMin ?? 0) === m
                      ? 'bg-emerald-600 text-white'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-850'}`}>
                  {remindLabel(m)}
                </button>
              ))}
            </div>

            <button type="button"
              onClick={() => set({ visibility: form.visibility === 'private' ? 'project' : 'private' })}
              className="w-full flex items-start gap-2.5 p-2.5 rounded-lg border border-slate-200 dark:border-slate-800
                         text-left cursor-pointer hover:border-emerald-500">
              <Lock className={`w-4 h-4 mt-0.5 shrink-0 ${form.visibility === 'private' ? 'text-emerald-600' : 'text-slate-400'}`} />
              <span>
                <span className="block text-xs font-semibold text-slate-800 dark:text-slate-100">
                  {form.visibility === 'private' ? 'Личное событие' : 'Событие проекта'}
                </span>
                <span className="block text-2xs text-slate-500 dark:text-slate-400">
                  {form.visibility === 'private'
                    ? 'Видите только вы — включая администратора.'
                    : 'Видят все, кто работает над проектом.'}
                </span>
              </span>
            </button>

            <label className="block">
              <span className={label}>Заметка</span>
              <textarea value={form.description || ''} onChange={(e) => set({ description: e.target.value })}
                rows={2} className={`${field} resize-none`} />
            </label>

            <div className="flex items-center gap-2 pt-1">
              {form.id && (
                <button type="button" onClick={drop}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold cursor-pointer
                             text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40">
                  <Trash2 className="w-3.5 h-3.5" /> Удалить
                </button>
              )}
              <span className="flex-1" />
              <button type="button" onClick={onClose}
                className="px-3 py-2 rounded-lg text-xs font-semibold cursor-pointer text-slate-600 dark:text-slate-300
                           hover:bg-slate-100 dark:hover:bg-slate-850">
                Отмена
              </button>
              <button type="button" onClick={submit} disabled={busy}
                className="px-4 py-2 rounded-lg text-xs font-semibold cursor-pointer bg-emerald-600 text-white
                           hover:bg-emerald-700 disabled:opacity-50">
                {form.id ? 'Сохранить' : 'Создать'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
