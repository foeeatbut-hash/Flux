import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useStore } from '../store/store';
import SectionShell from '../components/settings/SectionShell';
import LogsSection from '../components/settings/LogsSection';
import BrowserSection from '../components/settings/BrowserSection';
import GeneralSection from '../components/settings/GeneralSection';
import SignatureSection from '../components/settings/SignatureSection';
import { useToastStore } from '../store/toastStore';
import { useLogStore } from '../store/logStore';
import NotificationSettings from '../components/NotificationSettings';
import TranslateEngineSection from '../components/settings/TranslateEngineSection';
import UpdaterWidget from '../components/UpdaterWidget';
import {
  Settings, Database, Terminal, Bell, Briefcase, Fan, DownloadCloud, Tag, Archive, FileSpreadsheet, ShieldCheck, PenLine, Sigma, Languages, Globe, Gamepad2,
} from 'lucide-react';
import { isTopAdmin } from '../lib/roles';
import PlayPlatform from '../components/settings/PlayPlatform';
import TagRules from '../components/settings/TagRules';
import { canManagePlay } from '../lib/appPolicy';
import { useAppContext } from '../store/policyStore';
import { SectionHead } from '../components/ui';
import { PLAY_ADMIN } from '../../play/features';
import ManagementSection from '../components/settings/ManagementSection';
import BackupSection from '../components/settings/BackupSection';
import EquipmentSection from '../components/settings/EquipmentSection';
import TagsSection from '../components/settings/TagsSection';
import DatabaseSection from '../components/settings/DatabaseSection';
import FormulasSection from '../components/settings/FormulasSection';
import DocflowSection from '../components/settings/DocflowSection';
import RolesSection from '../components/settings/RolesSection';

// ── Раздел «Настройки» ─────────────────────────────────────────────────────────
// Все настройки программы в одном месте: категории слева (как в настройках
// Windows/iOS), содержимое выбранной категории справа. Сюда перенесены
// настройки из профиля и из отдельных разделов.

type SectionId = 'general' | 'signature' | 'roles' | 'management' | 'docflow' | 'formulas' | 'equipment' | 'tags' | 'notifications' | 'translate' | 'browser' | 'database' | 'backup' | 'logs' | 'updates' | 'play' | 'tagrules';

// Настройки делятся ровно так же, как остальные данные программы (см.
// src/lib/projectScope.ts): часть общая для всей программы, часть — своя у
// каждого проекта. Раньше они шли одним списком, и было непонятно, почему
// «Формулы документа», настроенные вчера, сегодня в другом проекте пустые.
type SettingScope = 'global' | 'project';

const SECTIONS: Array<{
  id: SectionId; label: string; icon: any; desc: string; scope: SettingScope;
  topOnly?: boolean;
  /**
   * Лист виден только по праву встроенной программы. От `topOnly` отличается
   * тем, что должность здесь не значит ничего: право выдаётся явно.
   */
  entitlement?: string;
  /** Главному администратору виден и без права */
  orTop?: boolean;
}> = [
  { id: 'general', label: 'Общие', icon: Settings, desc: 'Тема и плотность', scope: 'global' },
  // Подпись — настройка человека, и место ей здесь. До этого она пряталась
  // значком в подвале Пуска: найти её мог только тот, кто знал, что она там
  { id: 'signature', label: 'Моя подпись', icon: PenLine, desc: 'Чем подписаны документы', scope: 'global' },
  // Роли и доступ — дело одного главного администратора. Остальные не видят
  // этот лист вовсе: серая кнопка рассказывает о существовании двери, в
  // которую всё равно не войти, а отказ приходил уже от сервера — то есть
  // человек нажимал и получал ошибку
  { id: 'roles', label: 'Роли сотрудников', icon: ShieldCheck, desc: 'Кто кем работает', scope: 'global', topOnly: true },
  { id: 'management', label: 'Менеджмент', icon: Briefcase, desc: 'Этапы закупки', scope: 'global' },
  { id: 'docflow', label: 'Документооборот', icon: FileSpreadsheet, desc: 'Стандарты ВДР', scope: 'global' },
  { id: 'equipment', label: 'Оборудование', icon: Fan, desc: 'Категории оборудования', scope: 'global' },
  // «Теги» здесь — про способ соединять теги на холсте, а не про сами теги:
  // настройка одна на программу. Сами теги живут в проекте.
  { id: 'tags', label: 'Теги', icon: Tag, desc: 'Схема связей', scope: 'global' },
  { id: 'notifications', label: 'Уведомления', icon: Bell, desc: 'Какие события показывать', scope: 'global' },
  { id: 'translate', label: 'Переводчик', icon: Languages, desc: 'Чем переводим', scope: 'global' },
  { id: 'browser', label: 'Браузер', icon: Globe, desc: 'Куда разрешено ходить', scope: 'global' },
  { id: 'database', label: 'База данных', icon: Database, desc: 'На этом компьютере или на сервере', scope: 'global' },
  { id: 'backup', label: 'Резервные копии', icon: Archive, desc: 'Ежедневный архив данных', scope: 'global' },
  // Раньше пункт звался «Crash-логи»: сотруднику это ни о чём не говорит, а
  // теперь он сюда заходит не за файлами, а чтобы сообщить о сбое
  { id: 'logs', label: 'Ошибки и сбои', icon: Terminal, desc: 'Сообщить о сбое', scope: 'global' },
  { id: 'updates', label: 'Обновления', icon: DownloadCloud, desc: 'Версия и обновления', scope: 'global' },
  // Встроенная игровая платформа. Лист видит только тот, кому выдано её
  // управление, — и видит даже при выключенной платформе: иначе выключатель
  // отнимал бы право, которым его двигают
  // Главному администратору лист виден всегда: включить платформу больше некому
  { id: 'play', label: 'Flux Play', icon: Gamepad2, desc: 'Игровая платформа', scope: 'global', entitlement: PLAY_ADMIN, orTop: true },
  // Своё в каждом проекте
  { id: 'formulas', label: 'Формулы документа', icon: Sigma, desc: 'Дата, подпись, шифр', scope: 'project' },
  // Правила тегов: алфавит и приставки. Своё в каждом проекте — в одном
  // заказчик требует кириллицу, в другом её запрещает, и общее правило
  // сделало бы половину проектов неработающими
  { id: 'tagrules', label: 'Правила тегов', icon: Tag, desc: 'Алфавит и приставки', scope: 'project' },
];

const SETTING_GROUPS: Array<{ scope: SettingScope; label: string; hint: string }> = [
  { scope: 'global', label: 'Общее', hint: 'Одинаково во всей программе, для всех проектов' },
  { scope: 'project', label: 'Проект', hint: 'Своё в каждом проекте: сменили проект — здесь другие значения' },
];

export default function SettingsScreen() {
  const { user, theme, toggleTheme, density, setDensity } = useStore();
  const { addToast } = useToastStore();
  const addLog = useLogStore((s) => s.addLog);
  const [searchParams, setSearchParams] = useSearchParams();

  const initial = (searchParams.get('section') as SectionId) || 'general';
  const [section, setSection] = useState<SectionId>(SECTIONS.some(s => s.id === initial) ? initial : 'general');

  // Секция может смениться и через URL (туры ассистента, кнопка «Этапы» в
  // Менеджменте): следим за query и переключаемся, а не только при монтировании
  useEffect(() => {
    const fromUrl = searchParams.get('section') as SectionId | null;
    if (fromUrl && SECTIONS.some(s => s.id === fromUrl) && fromUrl !== section) {
      setSection(fromUrl);
    }
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (id: SectionId) => {
    setSection(id);
    setSearchParams({ section: id }, { replace: true });
  };

  const isAdmin = user?.role === 'ADMIN';
  // Главный администратор — уровень 1 (lib/roles). Роли и доступ доступны
  // только ему, и список настроек это учитывает, а не показывает всем
  const topAdmin = isTopAdmin(user);
  // Листы встроенных программ: должность их не открывает, только выданное право
  const policyCtx = useAppContext();
  const mayManagePlay = canManagePlay(policyCtx);
  const allows = React.useCallback(
    (def: { topOnly?: boolean; entitlement?: string; orTop?: boolean }) =>
      (!def.topOnly || topAdmin) && (!def.entitlement || mayManagePlay || (!!def.orTop && topAdmin)),
    [topAdmin, mayManagePlay],
  );

  // Раздел могли открыть по адресу — тот, кому он не положен, попадает
  // в «Общие», а не в пустую страницу с отказом
  React.useEffect(() => {
    const def = SECTIONS.find(s => s.id === section);
    if (def && !allows(def)) setSection('general');
  }, [section, allows]);

  return (
    <div className="fx-page @container">
      <SectionHead title="Настройки" />
      <div className="flex-1 min-h-0 flex">
      {/* Категории — боковой список, как в системных параметрах. Ширину
          спрашиваем у окна, а не у экрана: в узком окне остаются значки */}
      <nav className="fx-side w-12 @[700px]:w-56 @[980px]:w-64 shrink-0 overflow-y-auto p-2" aria-label="Категории настроек">
          {SETTING_GROUPS.map(g => (
          <React.Fragment key={g.scope}>
          {/* Заголовок области. В узкой колонке (только значки) вместо слова
              остаётся черта: подпись там всё равно не поместилась бы */}
          <div title={g.hint}>
            <div className="hidden @[700px]:block fx-gh mt-2 first:mt-0">{g.label}</div>
            <div className="@[700px]:hidden mx-1 my-2 border-t border-slate-200 dark:border-slate-800" />
          </div>
          {SECTIONS.filter(s => s.scope === g.scope && allows(s)).map(s => {
            const Icon = s.icon;
            return (
              <button type="button"
                key={s.id}
                onClick={() => pick(s.id)}
                aria-current={section === s.id ? 'true' : undefined}
                /* Метка для демонстраций помощника: они показывают пальцем на
                   раздел настроек, и метка обязана быть на нём самом */
                data-tour={`settings-${s.id}`}
                title={`${s.label} — ${s.desc}`}
                className="fx-li justify-center @[700px]:justify-start"
              >
                <Icon />
                <span className="hidden @[700px]:block truncate">{s.label}</span>
              </button>
            );
          })}
          </React.Fragment>
          ))}
      </nav>

      {/* Содержимое категории */}
      <div className="flex-1 min-w-0 overflow-y-auto px-4 @[700px]:px-8 py-4">
        {section === 'general' && <GeneralSection theme={theme} toggleTheme={toggleTheme} density={density} setDensity={setDensity} addToast={addToast} />}
        {section === 'signature' && <SignatureSection />}
        {section === 'roles' && <RolesSection user={user} addToast={addToast} />}
        {section === 'management' && <ManagementSection isAdmin={isAdmin} addToast={addToast} />}
        {section === 'equipment' && <EquipmentSection isAdmin={isAdmin} addToast={addToast} />}
        {section === 'docflow' && <DocflowSection isAdmin={isAdmin} addToast={addToast} />}
        {section === 'formulas' && <FormulasSection />}
        {section === 'tags' && <TagsSection addToast={addToast} />}
        {section === 'notifications' && (
          <SectionShell title="Уведомления" desc="Какие события показывать в панели уведомлений и как оповещать.">
            <NotificationSettings />
          </SectionShell>
        )}
        {section === 'translate' && (
          <SectionShell title="Переводчик" desc="Чем программа переводит и можно ли подключить свой движок.">
            <TranslateEngineSection />
          </SectionShell>
        )}
        {section === 'browser' && (
          <SectionShell title="Браузер" desc="Отделён от программы; список адресов ведёт администратор.">
            <BrowserSection />
          </SectionShell>
        )}
        {section === 'database' && <DatabaseSection addToast={addToast} />}
        {section === 'backup' && <BackupSection isAdmin={isAdmin} addToast={addToast} />}
        {section === 'logs' && <LogsSection addLog={addLog} />}
        {section === 'play' && <PlayPlatform addToast={addToast} />}
        {section === 'tagrules' && <TagRules addToast={addToast} />}
        {section === 'updates' && (
          <SectionShell title="Обновления" desc="Текущая версия программы и установка обновлений.">
            <UpdaterWidget />
          </SectionShell>
        )}
      </div>
      </div>
    </div>
  );
}



// Переключатель «включено/выключено», который живёт в localStorage и сообщает
// об изменении событием: так его слышат и главный экран, и рабочая область,
// не завися от того, где он нарисован.

