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
import {
  Settings, Database, Terminal, Bell, Briefcase, Fan, Tag, Archive, FileSpreadsheet, ShieldCheck, PenLine, Languages, Globe, Gamepad2,
} from 'lucide-react';
import { isTopAdmin } from '../lib/roles';
import { canAdmin } from '../lib/permissions';
import LicenseSection from '../components/settings/LicenseSection';
import PlayPlatform from '../components/settings/PlayPlatform';
import TagRules from '../components/settings/TagRules';
import { canManagePlay } from '../lib/appPolicy';
import { useAppContext } from '../store/policyStore';
import { SectionHead } from '../components/ui';
import { PLAY_ADMIN } from '../../play/features';
import { playEnabled } from '../../play/enabled';
import ManagementSection from '../components/settings/ManagementSection';
import BackupSection from '../components/settings/BackupSection';
import EquipmentSection from '../components/settings/EquipmentSection';
import TagsSection from '../components/settings/TagsSection';
import DatabaseSection from '../components/settings/DatabaseSection';
import DocflowSection from '../components/settings/DocflowSection';
import RolesSection from '../components/settings/RolesSection';

import { useShallow } from 'zustand/react/shallow';
import { canSeeSettingsSection, settingsSectionFromQuery } from '../lib/settingsVisibility';
// ── Раздел «Настройки» ─────────────────────────────────────────────────────────
// Все настройки программы в одном месте: категории слева (как в настройках
// Windows/iOS), содержимое выбранной категории справа. Сюда перенесены
// настройки из профиля и из отдельных разделов.

type SectionId = 'license' | 'general' | 'signature' | 'roles' | 'management' | 'docflow' | 'equipment' | 'tags' | 'notifications' | 'translate' | 'browser' | 'database' | 'backup' | 'logs' | 'play' | 'tagrules';

// Настройки делятся ровно так же, как остальные данные программы (см.
// src/lib/projectScope.ts): часть общая для всей программы, часть — своя у
// каждого проекта. Раньше они шли одним списком, и было непонятно, почему
// «Правила тегов», настроенные вчера, сегодня в другом проекте пустые.
type SettingScope = 'global' | 'project';

const SECTIONS: Array<{
  id: SectionId; label: string; icon: any; desc: string; scope: SettingScope;
  adminFeature?: string;
  ownerOnly?: boolean;
  /**
   * Лист виден только по праву встроенной программы: должность здесь не
   * значит ничего, право выдаётся явно.
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
  { id: 'roles', label: 'Роли сотрудников', icon: ShieldCheck, desc: 'Кто кем работает', scope: 'global', adminFeature: 'admin.roles.manage' },
  { id: 'management', label: 'Менеджмент', icon: Briefcase, desc: 'Этапы закупки', scope: 'global' },
  { id: 'docflow', label: 'Документооборот', icon: FileSpreadsheet, desc: 'Стандарты ВДР', scope: 'global' },
  { id: 'equipment', label: 'Оборудование', icon: Fan, desc: 'Категории оборудования', scope: 'global' },
  // «Теги» здесь — про способ соединять теги на холсте, а не про сами теги:
  // настройка одна на программу. Сами теги живут в проекте.
  { id: 'tags', label: 'Теги', icon: Tag, desc: 'Схема связей', scope: 'global' },
  { id: 'notifications', label: 'Уведомления', icon: Bell, desc: 'Какие события показывать', scope: 'global' },
  { id: 'translate', label: 'Переводчик', icon: Languages, desc: 'Чем переводим', scope: 'global' },
  { id: 'browser', label: 'Браузер', icon: Globe, desc: 'Куда разрешено ходить', scope: 'global' },
  { id: 'database', label: 'База данных', icon: Database, desc: 'Подключение сервера к БД', scope: 'global', ownerOnly: true },
  { id: 'license', label: 'Лицензии сотрудников', icon: ShieldCheck, desc: 'Запрос и активация лицензий', scope: 'global', adminFeature: 'admin.license.activate' },
  { id: 'backup', label: 'Резервные копии', icon: Archive, desc: 'Ежедневный архив данных', scope: 'global' },
  // Раньше пункт звался «Crash-логи»: сотруднику это ни о чём не говорит, а
  // теперь он сюда заходит не за файлами, а чтобы сообщить о сбое
  { id: 'logs', label: 'Ошибки и сбои', icon: Terminal, desc: 'Сообщить о сбое', scope: 'global' },
  // Встроенная игровая платформа. Лист видит только тот, кому выдано её
  // управление, — и видит даже при выключенной платформе: иначе выключатель
  // отнимал бы право, которым его двигают
  // Главному администратору лист виден всегда: включить платформу больше некому
  // Платформа отключена: лист есть только при FLUX_PLAY=1 (play/enabled.ts)
  ...(playEnabled() ? [{ id: 'play' as const, label: 'Flux Play', icon: Gamepad2, desc: 'Игровая платформа', scope: 'global' as const, entitlement: PLAY_ADMIN, orTop: true }] : []),
  // Своё в каждом проекте
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
  const { user, theme, toggleTheme, density, setDensity } = useStore(useShallow((s: ReturnType<typeof useStore.getState>) => ({ user: s.user, theme: s.theme, toggleTheme: s.toggleTheme, density: s.density, setDensity: s.setDensity })));
  const { addToast } = useToastStore();
  const addLog = useLogStore((s) => s.addLog);
  const [searchParams, setSearchParams] = useSearchParams();

  const initial = settingsSectionFromQuery(searchParams.get('section'), user) as SectionId;
  const [section, setSection] = useState<SectionId>(SECTIONS.some(s => s.id === initial) ? initial : 'general');

  const pick = (id: SectionId) => {
    setSection(id);
    setSearchParams({ section: id }, { replace: true });
  };

  const isAdmin = user?.role === 'OWNER';
  // Главный администратор — уровень 1 (lib/roles). Роли и доступ доступны
  // только ему, и список настроек это учитывает, а не показывает всем
  const topAdmin = isTopAdmin(user);
  // Листы встроенных программ: должность их не открывает, только выданное право
  const policyCtx = useAppContext();
  const mayManagePlay = canManagePlay(policyCtx);
  const allows = React.useCallback(
    (def: { id?: string; entitlement?: string; orTop?: boolean; ownerOnly?: boolean; adminFeature?: string }) =>
      (!def.ownerOnly || user?.role === 'OWNER') && (!def.adminFeature || canAdmin(user, def.adminFeature)) && (!def.id || canSeeSettingsSection(def.id, user)) && (!def.entitlement || mayManagePlay || (!!def.orTop && topAdmin)),
    [topAdmin, mayManagePlay, user],
  );

  // Секция может смениться и через URL (туры ассистента, кнопка «Этапы» в
  // Менеджменте): следим за query и переключаемся, а не только при монтировании.
  // При изменении профиля повторно проверяем прямой адрес.
  useEffect(() => {
    const fromUrl = searchParams.get('section') as SectionId | null;
    const definition = fromUrl ? SECTIONS.find(s => s.id === fromUrl) : undefined;
    if (fromUrl && definition && allows(definition) && fromUrl !== section) {
      setSection(fromUrl);
    }
  }, [searchParams, allows]);

  // Прямой адрес не должен даже кратко показывать содержимое закрытой категории
  // до того, как эффект синхронизирует выбранную категорию с адресной строкой.
  const displayedSection = React.useMemo(() => {
    const def = SECTIONS.find(s => s.id === section);
    return def && allows(def) ? section : 'general';
  }, [section, allows]);

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
        {displayedSection === 'general' && <GeneralSection theme={theme} toggleTheme={toggleTheme} density={density} setDensity={setDensity} addToast={addToast} />}
        {displayedSection === 'signature' && <SignatureSection />}
        {displayedSection === 'roles' && <RolesSection user={user} addToast={addToast} />}
        {displayedSection === 'management' && <ManagementSection isAdmin={isAdmin} addToast={addToast} />}
        {displayedSection === 'equipment' && <EquipmentSection isAdmin={isAdmin} addToast={addToast} />}
        {displayedSection === 'docflow' && <DocflowSection isAdmin={isAdmin} addToast={addToast} />}
        {displayedSection === 'tags' && <TagsSection addToast={addToast} />}
        {displayedSection === 'notifications' && (
          <SectionShell title="Уведомления" desc="Какие события показывать в панели уведомлений и как оповещать.">
            <NotificationSettings />
          </SectionShell>
        )}
        {displayedSection === 'translate' && (
          <SectionShell title="Переводчик" desc="Чем программа переводит и можно ли подключить свой движок.">
            <TranslateEngineSection />
          </SectionShell>
        )}
        {displayedSection === 'browser' && (
          <SectionShell title="Браузер" desc="Отделён от программы; список адресов ведёт администратор.">
            <BrowserSection />
          </SectionShell>
        )}
        {displayedSection === 'license' && <LicenseSection />}
        {displayedSection === 'database' && <DatabaseSection />}
        {displayedSection === 'backup' && <BackupSection isAdmin={isAdmin} mayRun={canAdmin(user, 'admin.backup.run')} addToast={addToast} />}
        {displayedSection === 'logs' && <LogsSection addLog={addLog} />}
        {playEnabled() && displayedSection === 'play' && <PlayPlatform addToast={addToast} />}
        {displayedSection === 'tagrules' && <TagRules addToast={addToast} />}
      </div>
      </div>
    </div>
  );
}
