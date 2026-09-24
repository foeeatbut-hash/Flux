/**
 * Браузер в параметрах: куда ему разрешено ходить.
 *
 * Программа работает в закрытом контуре, а браузер по определению ходит
 * наружу. Это надо назвать вслух, а не спрятать: у большинства список будет
 * пуст (можно куда угодно), но заказчику с закрытым контуром нужен обратный
 * режим — только перечисленные адреса, и никакие другие.
 *
 * Список общий на программу и ведёт его администратор: если бы каждый правил
 * свой, «разрешено» перестало бы что-либо значить.
 */
import React from 'react';
import { Globe, Plus, X, ShieldCheck } from 'lucide-react';
import { useBrowserStore } from '../../store/browserStore';
import { useStore } from '../../store/store';
import { useToastStore } from '../../store/toastStore';
import { hostOf } from '../../lib/browserUrl';

export default function BrowserSection() {
  const user = useStore((s) => s.user);
  const allowed = useBrowserStore((s) => s.allowed);
  const setAllowed = useBrowserStore((s) => s.setAllowed);
  const load = useBrowserStore((s) => s.load);
  const projectId = useStore((s) => s.activeProject?.id) || '';
  const { addToast } = useToastStore();
  const [draft, setDraft] = React.useState('');
  const isAdmin = user?.role === 'ADMIN';

  React.useEffect(() => { void load(projectId); }, [projectId, load]);

  const add = async () => {
    const raw = draft.trim();
    if (!raw) return;
    // Принимаем и адрес целиком, и просто хост: человек копирует из строки
    // браузера, а не набирает домен по памяти
    const host = (hostOf(raw.includes('://') ? raw : `https://${raw}`) || raw).toLowerCase();
    if (allowed.includes(host)) { setDraft(''); return; }
    await setAllowed([...allowed, host]);
    setDraft('');
    addToast(`Разрешено: ${host} и его поддомены`, 'success');
  };

  return (
    <div className="max-w-2xl space-y-5">
      <div className="fx-set-group">
        <div className="flex items-center gap-2 mb-2">
          <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
          <span className="text-sm font-bold">Страница не знает о программе</span>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
          Каждая вкладка — отдельный процесс со своей сессией: у страницы нет доступа ни к данным
          проекта, ни к самой программе. Всё общение идёт через ваши действия — сохранить, перевести,
          спросить помощника.
        </p>
      </div>

      <div className="fx-set-group space-y-3">
        <div className="flex items-center gap-2">
          <Globe className="w-4 h-4 text-slate-500 dark:text-slate-400" />
          <span className="text-sm font-bold">Куда разрешено ходить</span>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
          Список пуст — открываются любые адреса. Как только в нём появится хотя бы один, всё
          остальное перестанет открываться. Разрешение действует и на поддомены: <span className="font-mono">gost.ru</span>
          {' '}открывает и <span className="font-mono">docs.gost.ru</span>, но не
          {' '}<span className="font-mono">gost.ru.чужой-сайт.com</span>.
        </p>

        {isAdmin && (
          <div className="flex items-center gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add(); } }}
              placeholder="gost.ru или https://portal.zakupki.ru"
              className="flex-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg
                         px-3 py-2 text-sm text-slate-800 dark:text-slate-150 outline-none focus:border-emerald-400"
            />
            <button type="button" onClick={() => void add()}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold cursor-pointer
                         bg-emerald-600 text-white hover:bg-emerald-700">
              <Plus className="w-3.5 h-3.5" /> Добавить
            </button>
          </div>
        )}

        {allowed.length === 0 ? (
          <p className="text-2xs text-slate-400 dark:text-slate-500">
            Сейчас разрешены любые адреса.
          </p>
        ) : (
          <ul className="space-y-1">
            {allowed.map((h) => (
              <li key={h} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-900">
                <Globe className="w-3.5 h-3.5 shrink-0 text-slate-400" />
                <span className="flex-1 min-w-0 truncate text-xs font-mono text-slate-700 dark:text-slate-150">{h}</span>
                {isAdmin && (
                  <button type="button" onClick={() => void setAllowed(allowed.filter((x) => x !== h))}
                    title="Убрать из списка" aria-label={`Убрать ${h}`}
                    className="shrink-0 w-5 h-5 rounded flex items-center justify-center cursor-pointer
                               text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40">
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {!isAdmin && (
          <p className="text-2xs text-slate-400 dark:text-slate-500">
            Список ведёт администратор — он один на всю программу.
          </p>
        )}
      </div>
    </div>
  );
}
