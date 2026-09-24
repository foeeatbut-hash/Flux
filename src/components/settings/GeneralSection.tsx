/**
 * Лист «Общие» в Параметрах: тема, плотность, где искать разделы, живой фон.
 *
 * Вынесен из SettingsScreen отдельным файлом, а не оставлен там: экран уже
 * упирался в потолок размера, и добавить в него ещё один блок значило бы
 * поднять потолок вместо того, чтобы разгрузить файл.
 */
import React from 'react';
import { Seg, SettingRow, Switch } from '../ui';
import SectionShell from './SectionShell';
import ToggleRow from './ToggleRow';
import FluxLogo from '../FluxLogo';
import OnlineVisibility from './OnlineVisibility';

export default function GeneralSection({ theme, toggleTheme, density, setDensity, addToast }: any) {
  return (
    <SectionShell title="Общие" desc="Внешний вид программы.">
      <div className="fx-set-group">
        <h3 className="fx-group-title">Вид</h3>
        <SettingRow title="Тема интерфейса">
          <Seg label="Тема интерфейса" value={theme === 'dark' ? 'dark' : 'light'}
            onChange={(v) => { if ((v === 'dark') !== (theme === 'dark')) toggleTheme(); }}
            options={[{ value: 'light', label: 'Светлая' }, { value: 'dark', label: 'Тёмная' }]} />
        </SettingRow>
        <SettingRow title="Плотность" desc="Сколько строк помещается на экране: таблицы и списки во всех разделах.">
          <Seg label="Плотность" value={density} onChange={setDensity}
            options={[{ value: 'compact', label: 'Компактно' }, { value: 'standard', label: 'Стандарт' }, { value: 'comfortable', label: 'Просторно' }]} />
        </SettingRow>
      </div>

      <div className="fx-set-group">
        <h3 className="fx-group-title">Главный экран и помощник</h3>
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

      {/* Присутствие. Блок сам решает, показываться ли: право скрыть себя
          есть только у главного администратора, и спрашивается оно у сервера */}
      <OnlineVisibility addToast={addToast} />

      <StartupSection />

      <div className="fx-set-group">
        <h3 className="fx-group-title">О программе</h3>
        <div className="flex items-center gap-3 py-3">
          <FluxLogo size={36} radius={10} />
          <div className="min-w-0">
            <div className="text-slate-900 dark:text-white">Flux <span className="text-slate-400 tabular-nums ml-1">v{__APP_VERSION__}</span></div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Разработка Раупова Хусрава</div>
          </div>
        </div>
        {/* Лицензия Apache-2.0 разрешает переименовать редактор, но требует
            назвать исходный проект и приложить его LICENSE и NOTICE — они
            лежат рядом с редактором (tools/genoffice/build.mjs) */}
        <div className="text-xs text-slate-500 dark:text-slate-400 pb-3">
          Сторонние компоненты: редактор документов Flux Office основан на GenOffice (Apache-2.0),{' '}
          <a className="underline" href="genoffice/NOTICE" target="_blank" rel="noreferrer">лицензия и уведомление</a>.
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

  return (
    <div className="fx-set-group">
      <h3 className="fx-group-title">Запуск</h3>
      <SettingRow title="Запускать Flux при входе в Windows" desc="Программа поднимется сама вместе с системой.">
        <Switch label="Запускать Flux при входе в Windows" checked={state.enabled} onChange={(v) => apply({ enabled: v, minimized: state.minimized })} />
      </SettingRow>
      <SettingRow title="Запускаться свёрнутым" desc="Окно не полезет поверх всего при входе в систему, но уведомления начнут приходить с утра.">
        <Switch label="Запускаться свёрнутым" checked={state.minimized} disabled={!state.enabled} onChange={(v) => apply({ enabled: state.enabled, minimized: v })} />
      </SettingRow>
    </div>
  );
}
