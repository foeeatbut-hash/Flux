/**
 * Лист «Общие» в Параметрах: тема, плотность, где искать разделы, живой фон.
 *
 * Вынесен из SettingsScreen отдельным файлом, а не оставлен там: экран уже
 * упирался в потолок размера, и добавить в него ещё один блок значило бы
 * поднять потолок вместо того, чтобы разгрузить файл.
 */
import React from 'react';
import { Sun, Moon } from 'lucide-react';
import SectionShell from './SectionShell';
import ToggleRow from './ToggleRow';
import FluxLogo from '../FluxLogo';
import OnlineVisibility from './OnlineVisibility';

export default function GeneralSection({ theme, toggleTheme, density, setDensity, addToast }: any) {
  return (
    <SectionShell title="Общие" desc="Внешний вид программы.">
      <div className="space-y-4">
        <div className="p-4 rounded-xl border border-slate-150 dark:border-slate-850 bg-slate-50/50 dark:bg-slate-900/30">
          <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">Тема интерфейса</div>
          {/* Переключатель, а не две залитые кнопки: выбранное состояние
              показывается плашкой, а не полным фирменным цветом. */}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-1 p-1 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950">
            <button
              type="button"
              onClick={() => { if (theme === 'dark') toggleTheme(); }}
              aria-pressed={theme !== 'dark'}
              className={`py-2 px-2 min-w-0 rounded-lg text-sm font-semibold transition-colors duration-[120ms] flex items-center justify-center gap-2 cursor-pointer ${
                theme !== 'dark' ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-800 dark:text-emerald-300' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white'
              }`}
            >
              <Sun className="w-4 h-4" /> Светлая
            </button>
            <button
              type="button"
              onClick={() => { if (theme !== 'dark') toggleTheme(); }}
              aria-pressed={theme === 'dark'}
              className={`py-2 px-2 min-w-0 rounded-lg text-sm font-semibold transition-colors duration-[120ms] flex items-center justify-center gap-2 cursor-pointer ${
                theme === 'dark' ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-800 dark:text-emerald-300' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white'
              }`}
            >
              <Moon className="w-4 h-4" /> Тёмная
            </button>
          </div>
        </div>

        <div className="p-4 rounded-xl border border-slate-150 dark:border-slate-850 bg-slate-50/50 dark:bg-slate-900/30">
          <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">Плотность</div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
            Сколько строк помещается на экране. Влияет на таблицы и списки во всех разделах.
          </p>
          {/* Три равные доли ширины вместо ряда по содержимому. Было inline-flex:
              ряд считался по самым длинным подписям, не переносился и не сжимался —
              при узком окне он вылезал за карточку на 47 px, и «Компактно»
              обрезалось. Сетка не может стать шире родителя. */}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(96px,1fr))] gap-1 p-1 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950">
            {([
              { key: 'comfortable', label: 'Просторно' },
              { key: 'standard', label: 'Стандарт' },
              { key: 'compact', label: 'Компактно' },
            ] as const).map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setDensity(opt.key)}
                aria-pressed={density === opt.key}
                title={opt.label}
                className={`min-w-0 truncate py-2 px-2 rounded-lg text-sm font-semibold transition-colors duration-[120ms] cursor-pointer ${
                  density === opt.key ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-800 dark:text-emerald-300' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="p-4 rounded-xl border border-slate-150 dark:border-slate-850 bg-slate-50/50 dark:bg-slate-900/30">
          <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">Главный экран и помощник</div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
            Живой фон по времени года и картины в шапке помощника. Если отвлекают — выключите.
          </p>
          <div className="space-y-2">
            <ToggleRow
              storageKey="flux_backdrop"
              event="flux:backdrop-changed"
              title="Фон главного экрана"
              desc="Снег зимой, листья осенью, солнце и луна по времени суток. В день рождения — шарики."
            />
            <ToggleRow
              storageKey="flux_art"
              event="flux:art-changed"
              title="Картины в шапке помощника"
              desc="Ван Гог, Хокусай, да Винчи, Моне, Айвазовский — нарисованы кодом и оживают. Нажатие на полке меняет картину."
            />
          </div>
        </div>

        {/* Присутствие. Блок сам решает, показываться ли: право скрыть себя
            есть только у главного администратора, и спрашивается оно у сервера */}
        <OnlineVisibility addToast={addToast} />

        <StartupSection />

        <div className="p-4 rounded-xl border border-slate-150 dark:border-slate-850 bg-slate-50/50 dark:bg-slate-900/30">
          <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">О программе</div>
          <div className="flex items-center gap-3.5">
            <FluxLogo size={46} radius={13} />
            <div className="min-w-0">
              <div className="text-sm font-bold text-slate-800 dark:text-white flex items-center gap-2">
                Flux
                <span className="font-mono text-xs font-normal text-slate-400 dark:text-slate-500">v{__APP_VERSION__}</span>
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Разработка <span className="font-semibold text-slate-600 dark:text-slate-300">Раупова Хусрава</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </SectionShell>
  );
}

// ── Менеджмент: редактор этапов закупки и шаблонов ─────────────────────────────
// Стандартный набор этапов — общий по умолчанию. Дополнительно можно завести
// именованные шаблоны со своими этапами и правилами применения: отделы (классы),
// типы оборудования, категории установок, подстроки обозначения. Отдельным
// тегам шаблон назначается вручную в разделе «Менеджмент».

// Переиспользуемый редактор списка этапов (для стандартного набора и шаблонов)

/**
 * Автозапуск вместе с Windows.
 *
 * Состояние спрашивается у системы при каждом открытии параметров, а не
 * помнится своё: автозапуск могли снять снаружи, и галочка, рассказывающая о
 * своём прошлом решении, хуже отсутствующей.
 *
 * В браузере (не в Electron) блока нет вовсе: обещать автозапуск там, где его
 * не бывает, — это переключатель, который ничего не делает.
 */
function StartupSection() {
  const api = (window as any).electron?.startup;
  const [state, setState] = React.useState<{ enabled: boolean; minimized: boolean } | null>(null);

  React.useEffect(() => {
    if (!api) return;
    let alive = true;
    api.get().then((s: any) => { if (alive) setState({ enabled: !!s?.enabled, minimized: !!s?.minimized }); })
      .catch(() => { if (alive) setState({ enabled: false, minimized: false }); });
    return () => { alive = false; };
  }, [api]);

  if (!api || !state) return null;

  const apply = async (next: { enabled: boolean; minimized: boolean }) => {
    setState(next);
    try {
      const got = await api.set(next);
      // Верим системе, а не себе: она могла и отказать
      setState({ enabled: !!got?.enabled, minimized: !!got?.minimized });
    } catch (_) { /* система не дала — состояние перечитается при следующем открытии */ }
  };

  const Row = ({ on, disabled, title, desc, onFlip }: {
    on: boolean; disabled?: boolean; title: string; desc: string; onFlip: () => void;
  }) => (
    <button type="button" onClick={onFlip} role="switch" aria-checked={on} disabled={disabled}
      className={`w-full flex items-start gap-3 p-3 rounded-lg border border-slate-200 dark:border-slate-800
                  bg-white dark:bg-slate-950 text-left transition-ui
                  ${disabled ? 'opacity-40 cursor-not-allowed' : 'hover:border-emerald-500 cursor-pointer'}`}>
      <span className={`mt-0.5 shrink-0 w-9 h-5 rounded-full p-0.5 transition-colors ${on ? 'bg-emerald-600' : 'bg-slate-300 dark:bg-slate-700'}`}>
        <span className={`block w-4 h-4 rounded-full bg-white transition-transform ${on ? 'translate-x-4' : ''}`} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-slate-800 dark:text-slate-100 break-words">{title}</span>
        <span className="block text-xs text-slate-500 dark:text-slate-400 mt-0.5 break-words text-pretty">{desc}</span>
      </span>
    </button>
  );

  return (
    <div className="p-4 rounded-xl border border-slate-150 dark:border-slate-850 bg-slate-50/50 dark:bg-slate-900/30">
      <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">Запуск</div>
      <div className="space-y-2">
        <Row
          on={state.enabled}
          title="Запускать Flux при входе в Windows"
          desc="Программа поднимется сама вместе с системой."
          onFlip={() => apply({ enabled: !state.enabled, minimized: state.minimized })}
        />
        <Row
          on={state.minimized}
          disabled={!state.enabled}
          title="Запускаться свёрнутым"
          desc="Окно не полезет поверх всего при входе в систему, но уведомления начнут приходить с утра."
          onFlip={() => apply({ enabled: state.enabled, minimized: !state.minimized })}
        />
      </div>
    </div>
  );
}
