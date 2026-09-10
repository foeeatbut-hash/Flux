import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useStore } from '../store/store';
import SectionShell from '../components/settings/SectionShell';
import LogsSection from '../components/settings/LogsSection';
import BrowserSection from '../components/settings/BrowserSection';
import GeneralSection from '../components/settings/GeneralSection';
import SignatureSection from '../components/settings/SignatureSection';
import ToggleRow from '../components/settings/ToggleRow';
import { useToastStore } from '../store/toastStore';
import { useLogStore } from '../store/logStore';
import NotificationSettings from '../components/NotificationSettings';
import TranslateEngineSection from '../components/settings/TranslateEngineSection';
import UpdaterWidget from '../components/UpdaterWidget';
import CustomSelect from '../components/CustomSelect';
import FluxLogo from '../components/FluxLogo';
import { ENV_CONFIG } from '../config/env';
import {
  Settings, Sun, Moon, Database, Terminal, Bell, Briefcase, Fan, DownloadCloud,
  Plus, Trash2, ChevronUp, ChevronDown, RotateCcw, Loader2, Check,
  Tag, MousePointerClick, Link2, Archive, PlayCircle, FolderOpen, FileSpreadsheet, X,
  ShieldCheck, Lock, Pencil, PenLine, Sigma, Languages, Globe } from 'lucide-react';
import RoleIcon from '../components/RoleIcon';
import FormulaManager from '../components/FormulaManager';
import {
  Role, ROLE_COLORS, ROLE_ICONS, roleColorClass, loadRoles, invalidateRoles, isTopAdmin,
} from '../lib/roles';
import { FEATURES, FEATURE_GROUPS, PermMap, parsePermissions } from '../lib/permissions';
import { getAuthToken } from '../config/env';
import { motion } from 'motion/react';
import {
  ProcurementStage, StageTemplate, DEFAULT_STAGES, STAGE_ICONS, STAGE_COLORS,
  loadProcurementStages, saveProcurementStages, stageIcon, stageColor,
  loadStageTemplates, saveStageTemplates, emptyRules
} from '../lib/procurementStages';
import { countOf } from '../lib/plural';
import { useModalStore } from '../store/modalStore';

// Диалоги программы вместо системных окон Windows
const { openConfirm, openAlert, openPrompt } = useModalStore.getState();

// ── Раздел «Настройки» ─────────────────────────────────────────────────────────
// Все настройки программы в одном месте: категории слева (как в настройках
// Windows/iOS), содержимое выбранной категории справа. Сюда перенесены
// настройки из профиля и из отдельных разделов.

type SectionId = 'general' | 'signature' | 'roles' | 'management' | 'docflow' | 'formulas' | 'equipment' | 'tags' | 'notifications' | 'translate' | 'browser' | 'database' | 'backup' | 'logs' | 'updates';

// Настройки делятся ровно так же, как остальные данные программы (см.
// src/lib/projectScope.ts): часть общая для всей программы, часть — своя у
// каждого проекта. Раньше они шли одним списком, и было непонятно, почему
// «Формулы документа», настроенные вчера, сегодня в другом проекте пустые.
type SettingScope = 'global' | 'project';

const SECTIONS: Array<{ id: SectionId; label: string; icon: any; desc: string; scope: SettingScope; topOnly?: boolean }> = [
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
  // Своё в каждом проекте
  { id: 'formulas', label: 'Формулы документа', icon: Sigma, desc: 'Дата, подпись, шифр', scope: 'project' },
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

  // Раздел могли открыть по адресу — тот, кому он не положен, попадает
  // в «Общие», а не в пустую страницу с отказом
  React.useEffect(() => {
    const def = SECTIONS.find(s => s.id === section);
    if (def?.topOnly && !topAdmin) setSection('general');
  }, [section, topAdmin]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="h-full flex gap-4 text-slate-800 dark:text-slate-100"
    >
      {/* Категории (левая колонка). Ширину спрашиваем у панели, а не у окна:
          при 288 px намертво в узкой панели содержимому оставалось меньше
          трети, и ряды кнопок внутри резались многоточием. */}
      <div className="w-14 @[700px]:w-56 @[980px]:w-72 shrink-0 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-850 rounded-lg shadow-xs overflow-hidden flex flex-col">
        <div className="px-2 @[700px]:px-4 py-3.5 border-b border-slate-100 dark:border-slate-850 flex items-center justify-center @[700px]:justify-start gap-2">
          <Settings className="w-4.5 h-4.5 text-emerald-600 shrink-0" />
          <h1 className="hidden @[700px]:block text-base font-bold text-slate-900 dark:text-white">Настройки</h1>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {SETTING_GROUPS.map(g => (
          <React.Fragment key={g.scope}>
          {/* Заголовок области. В узкой колонке (только значки) вместо слова
              остаётся черта: подпись там всё равно не поместилась бы, а разрыв
              между группами нужен. */}
          <div className="pt-1.5 first:pt-0" title={g.hint}>
            <div className="hidden @[700px]:block px-3 pb-1 text-2xs font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 select-none">{g.label}</div>
            <div className="@[700px]:hidden mx-2 mb-1 border-t border-slate-200 dark:border-slate-800" />
          </div>
          {SECTIONS.filter(s => s.scope === g.scope && (!s.topOnly || topAdmin)).map(s => {
            const Icon = s.icon;
            const active = section === s.id;
            return (
              <button type="button"
                key={s.id}
                onClick={() => pick(s.id)}
                aria-current={active ? 'page' : undefined}
                /* Метка для демонстраций помощника: они показывают пальцем на
                   раздел настроек, и метка обязана быть на нём самом */
                data-tour={`settings-${s.id}`}
                title={`${s.label} — ${s.desc}`}
                className={`relative w-full flex items-start justify-center @[700px]:justify-start gap-3 px-1.5 @[700px]:px-3 py-2.5 rounded-xl text-left transition-ui cursor-pointer ${
                  active
                    ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-900 dark:text-emerald-200 font-semibold before:absolute before:left-0 before:top-2 before:bottom-2 before:w-1 before:rounded-r before:bg-emerald-600 dark:before:bg-emerald-400'
                    : 'hover:bg-slate-100 dark:hover:bg-slate-900 text-slate-700 dark:text-slate-300'
                }`}
              >
                <Icon className={`w-4.5 h-4.5 mt-0.5 shrink-0 ${active ? 'text-emerald-700 dark:text-emerald-300' : 'text-emerald-600 dark:text-emerald-400'}`} />
                <span className="hidden @[700px]:block min-w-0">
                  <span className="block text-sm font-semibold leading-tight">{s.label}</span>
                  {/* Пояснение под названием — только когда панель широкая:
                      в узкой оно всё равно обрывалось многоточием, а место
                      забирало у содержимого настроек */}
                  <span className={`hidden @[980px]:block text-xs leading-tight mt-0.5 truncate ${active ? 'text-emerald-700/80 dark:text-emerald-300/80' : 'text-slate-400'}`}>{s.desc}</span>
                </span>
              </button>
            );
          })}
          </React.Fragment>
          ))}
        </div>
      </div>

      {/* Содержимое категории */}
      <div className="flex-1 min-w-0 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-850 rounded-lg shadow-xs overflow-y-auto p-3 @[700px]:p-6">
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
        {section === 'updates' && (
          <SectionShell title="Обновления" desc="Текущая версия программы и установка обновлений.">
            <div className="max-w-md"><UpdaterWidget /></div>
          </SectionShell>
        )}
      </div>
    </motion.div>
  );
}


// ── Общие ──────────────────────────────────────────────────────────────────────
function StageListEditor({ stages, onChange, isAdmin, addToast }: {
  stages: ProcurementStage[];
  onChange: (next: ProcurementStage[]) => void;
  isAdmin: boolean;
  addToast: (msg: string, type?: string) => void;
}) {
  const [editingIconFor, setEditingIconFor] = useState<string | null>(null);

  const update = (id: string, patch: Partial<ProcurementStage>) => {
    onChange(stages.map(s => s.id === id ? { ...s, ...patch } : s));
  };

  const move = (idx: number, dir: -1 | 1) => {
    const next = [...stages];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    onChange(next);
  };

  const addStage = () => {
    const id = 'st' + Date.now().toString(36);
    onChange([...stages, { id, label: 'Новый этап', icon: 'Flag', color: 'indigo' }]);
  };

  const removeStage = async (id: string) => {
    if (stages.length <= 2) {
      addToast('Должно остаться минимум два этапа', 'error');
      return;
    }
    if (!await openConfirm('Удалить этап закупки?', 'Позиции с этого этапа вернутся на первый.', { confirmLabel: 'Удалить этап', tone: 'danger' })) return;
    onChange(stages.filter(s => s.id !== id));
  };

  return (
    <>
      <div className="space-y-2 mb-3">
        {stages.map((s, idx) => {
          const Icon = stageIcon(s.icon);
          const c = stageColor(s.color);
          return (
            <div key={s.id} className={`p-3 rounded-xl border ${c.border} ${c.bg} flex flex-wrap items-center gap-2.5`}>
              {/* Порядок */}
              <div className="flex flex-col">
                <button type="button" disabled={!isAdmin || idx === 0} onClick={() => move(idx, -1)} className="p-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-white disabled:opacity-20 cursor-pointer"><ChevronUp className="w-3.5 h-3.5" /></button>
                <button type="button" disabled={!isAdmin || idx === stages.length - 1} onClick={() => move(idx, 1)} className="p-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-white disabled:opacity-20 cursor-pointer"><ChevronDown className="w-3.5 h-3.5" /></button>
              </div>

              <span className={`w-6 text-center text-xs font-black ${c.color}`}>{idx + 1}</span>

              {/* Значок */}
              <div className="relative">
                <button type="button"
                  disabled={!isAdmin}
                  onClick={() => setEditingIconFor(editingIconFor === s.id ? null : s.id)}
                  className={`w-9 h-9 rounded-full border ${c.border} ${c.color} bg-white/70 dark:bg-slate-950/60 flex items-center justify-center cursor-pointer hover:scale-105 transition-transform`}
                  title="Выбрать значок"
                >
                  <Icon className="w-4.5 h-4.5" />
                </button>
                {editingIconFor === s.id && (
                  <div className="absolute top-full left-0 mt-1 z-30 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl p-2 grid grid-cols-8 gap-1 w-72">
                    {Object.keys(STAGE_ICONS).map(name => {
                      const I = STAGE_ICONS[name];
                      return (
                        <button type="button"
                          key={name}
                          onClick={() => { update(s.id, { icon: name }); setEditingIconFor(null); }}
                          className={`w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-900 ${s.icon === name ? 'bg-emerald-100 dark:bg-emerald-950/50 text-emerald-600' : 'text-slate-500'}`}
                          title={name}
                        >
                          <I className="w-4 h-4" />
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Название */}
              <input
                disabled={!isAdmin}
                defaultValue={s.label}
                onBlur={(e) => { if (e.target.value.trim() && e.target.value !== s.label) update(s.id, { label: e.target.value.trim() }); }}
                className="flex-1 min-w-[140px] px-3 py-2 bg-white/80 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800 rounded-lg text-sm font-semibold text-slate-800 dark:text-slate-100 focus:outline-none focus:border-emerald-500"
              />

              {/* Цвет */}
              <div className="flex items-center gap-1">
                {Object.keys(STAGE_COLORS).map(colorName => (
                  <button type="button"
                    key={colorName}
                    disabled={!isAdmin}
                    onClick={() => update(s.id, { color: colorName })}
                    className={`w-5 h-5 rounded-full ${STAGE_COLORS[colorName].solid} cursor-pointer transition-ui ${s.color === colorName ? 'ring-2 ring-offset-1 dark:ring-offset-slate-950 ring-slate-500 scale-110' : 'opacity-60 hover:opacity-100'}`}
                    title={colorName}
                  />
                ))}
              </div>

              {/* Удалить (первый этап — базовый, не удаляется) */}
              <button type="button"
                disabled={!isAdmin || idx === 0}
                onClick={() => removeStage(s.id)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-white/60 dark:hover:bg-slate-900 disabled:opacity-20 cursor-pointer"
                title={idx === 0 ? 'Первый (начальный) этап нельзя удалить' : 'Удалить этап'}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          );
        })}
      </div>

      {isAdmin && (
        <button type="button" onClick={addStage} className="flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold cursor-pointer">
          <Plus className="w-4 h-4" /> Добавить этап
        </button>
      )}
    </>
  );
}

// Редактор списка значений правила (через запятую)
function RuleListInput({ label, hint, values, onChange, disabled }: {
  label: string; hint: string; values: string[]; onChange: (v: string[]) => void; disabled: boolean;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider">{label}</label>
      <input
        disabled={disabled}
        defaultValue={values.join(', ')}
        placeholder={hint}
        onBlur={(e) => {
          const next = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
          if (JSON.stringify(next) !== JSON.stringify(values)) onChange(next);
        }}
        className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-xs text-slate-800 dark:text-slate-100 focus:outline-none focus:border-emerald-500"
      />
    </div>
  );
}

function ManagementSection({ isAdmin, addToast }: any) {
  const [stages, setStages] = useState<ProcurementStage[]>([]);
  const [templates, setTemplates] = useState<StageTemplate[]>([]);
  const [activeId, setActiveId] = useState<string>('default'); // 'default' | id шаблона
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([loadProcurementStages(), loadStageTemplates()]).then(([s, t]) => {
      setStages(s); setTemplates(t); setLoading(false);
    });
  }, []);

  const persistStages = async (next: ProcurementStage[]) => {
    setStages(next);
    setSaving(true);
    const ok = await saveProcurementStages(next);
    setSaving(false);
    if (!ok) addToast('Не удалось сохранить этапы', 'error');
  };

  const persistTemplates = async (next: StageTemplate[]) => {
    setTemplates(next);
    setSaving(true);
    const ok = await saveStageTemplates(next);
    setSaving(false);
    if (!ok) addToast('Не удалось сохранить шаблоны', 'error');
  };

  const activeTemplate = templates.find(t => t.id === activeId) || null;

  const updateTemplate = (id: string, patch: Partial<StageTemplate>) => {
    persistTemplates(templates.map(t => t.id === id ? { ...t, ...patch } : t));
  };

  const addTemplate = () => {
    const id = 'tpl' + Date.now().toString(36);
    const tpl: StageTemplate = {
      id,
      name: 'Новый шаблон',
      stages: DEFAULT_STAGES.map(s => ({ ...s, id: `${id}_${s.id}` })),
      rules: emptyRules(),
    };
    persistTemplates([...templates, tpl]);
    setActiveId(id);
  };

  const removeTemplate = async (id: string) => {
    if (!await openConfirm('Удалить шаблон этапов?', 'Позиции, которые им пользуются, вернутся на стандартные этапы.', { confirmLabel: 'Удалить шаблон', tone: 'danger' })) return;
    persistTemplates(templates.filter(t => t.id !== id));
    setActiveId('default');
  };

  if (loading) return <SectionShell title="Менеджмент" desc="Загрузка…"><Loader2 className="w-5 h-5 animate-spin text-emerald-600" /></SectionShell>;

  return (
    <SectionShell title="Менеджмент" desc="Этапы закупки: общий набор и шаблоны по правилам.">
      {!isAdmin && (
        <div className="mb-4 p-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 text-xs text-amber-700 dark:text-amber-300">
          Изменять этапы и шаблоны может администратор. Вы видите текущую настройку.
        </div>
      )}

      {/* Переключатель: стандартный набор + шаблоны */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <button type="button"
          onClick={() => setActiveId('default')}
          className={`px-3 py-1.5 rounded-lg text-xs font-bold border cursor-pointer transition-ui ${activeId === 'default' ? 'bg-emerald-600 border-emerald-700 text-white' : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:border-emerald-400'}`}
        >
          Стандартные этапы
        </button>
        {templates.map(t => (
          <button type="button"
            key={t.id}
            onClick={() => setActiveId(t.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold border cursor-pointer transition-ui ${activeId === t.id ? 'bg-emerald-600 border-emerald-700 text-white' : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:border-emerald-400'}`}
          >
            {t.name}
          </button>
        ))}
        {isAdmin && (
          <button type="button"
            onClick={addTemplate}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold border border-dashed border-slate-300 dark:border-slate-700 text-slate-500 hover:border-emerald-400 hover:text-emerald-600 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" /> Новый шаблон
          </button>
        )}
      </div>

      {activeId === 'default' ? (
        <>
          <StageListEditor stages={stages} onChange={persistStages} isAdmin={isAdmin} addToast={addToast} />
          {isAdmin && (
            <div className="flex items-center gap-2 mt-3">
              <button type="button"
                onClick={async () => { if (await openConfirm('Вернуть стандартные этапы?', 'Ваши изменения в списке этапов будут потеряны.', { confirmLabel: 'Вернуть' })) persistStages(DEFAULT_STAGES); }}
                className="flex items-center gap-1.5 px-3.5 py-2 bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-lg text-xs font-bold cursor-pointer"
              >
                <RotateCcw className="w-4 h-4" /> Стандартные этапы
              </button>
              {saving
                ? <span className="text-xs text-slate-400 flex items-center gap-1"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Сохранение…</span>
                : <span className="text-xs text-emerald-600 flex items-center gap-1"><Check className="w-3.5 h-3.5" /> Сохраняется автоматически</span>}
            </div>
          )}
        </>
      ) : activeTemplate ? (
        <div className="space-y-5">
          {/* Имя шаблона и удаление */}
          <div className="flex items-center gap-2">
            <input
              disabled={!isAdmin}
              defaultValue={activeTemplate.name}
              onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== activeTemplate.name) updateTemplate(activeTemplate.id, { name: v }); }}
              className="flex-1 min-w-0 px-3 py-2 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-sm font-bold text-slate-800 dark:text-slate-100 focus:outline-none focus:border-emerald-500"
              placeholder="Название шаблона"
            />
            {isAdmin && (
              <button type="button"
                onClick={() => removeTemplate(activeTemplate.id)}
                className="p-2 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30 cursor-pointer"
                title="Удалить шаблон"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Правила применения */}
          <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-3">
            <div className="text-xs font-bold uppercase tracking-wider text-slate-400">Когда применяется (автоматически)</div>
            <div className="grid @[820px]:grid-cols-2 gap-3">
              <RuleListInput
                label="Отделы / классы тегов"
                hint="ОВ, ВК, ЭОМ (через запятую)"
                values={activeTemplate.rules.departments}
                onChange={(v) => updateTemplate(activeTemplate.id, { rules: { ...activeTemplate.rules, departments: v } })}
                disabled={!isAdmin}
              />
              <RuleListInput
                label="Типы оборудования"
                hint="КЛАПАН, ФИЛЬТР, ВЕНТИЛЯТОР"
                values={activeTemplate.rules.equipTypes}
                onChange={(v) => updateTemplate(activeTemplate.id, { rules: { ...activeTemplate.rules, equipTypes: v } })}
                disabled={!isAdmin}
              />
              <RuleListInput
                label="Категории установок"
                hint="AHU, FAN, VALVE"
                values={activeTemplate.rules.categories}
                onChange={(v) => updateTemplate(activeTemplate.id, { rules: { ...activeTemplate.rules, categories: v } })}
                disabled={!isAdmin}
              />
              <RuleListInput
                label="Обозначение содержит"
                hint="P-, -EX, AHU (подстроки)"
                values={activeTemplate.rules.identifierIncludes}
                onChange={(v) => updateTemplate(activeTemplate.id, { rules: { ...activeTemplate.rules, identifierIncludes: v } })}
                disabled={!isAdmin}
              />
            </div>
            <p className="text-2xs text-slate-400 leading-relaxed">
              Шаблон применится к тегу, если совпало хотя бы одно правило. Приоритет: назначение вручную →
              обозначение → тип оборудования → категория установки → отдел. Назначить шаблон конкретным
              тегам вручную можно в разделе «Менеджмент» (выделите позиции → «Шаблон этапов»).
            </p>
          </div>

          {/* Этапы шаблона */}
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">Этапы шаблона</div>
            <StageListEditor
              stages={activeTemplate.stages}
              onChange={(next) => updateTemplate(activeTemplate.id, { stages: next })}
              isAdmin={isAdmin}
              addToast={addToast}
            />
          </div>

          {saving
            ? <span className="text-xs text-slate-400 flex items-center gap-1"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Сохранение…</span>
            : <span className="text-xs text-emerald-600 flex items-center gap-1"><Check className="w-3.5 h-3.5" /> Сохраняется автоматически</span>}
        </div>
      ) : null}
    </SectionShell>
  );
}

// ── Резервные копии ────────────────────────────────────────────────────────────
// Ежедневный «Архив»: копия базы + все файлы Проводника в родных форматах по
// папкам + данные проектов в Excel. Если всё полетит — папка с датой читается
// без программы. Плюс страховочные копии базы при каждом запуске.
function BackupSection({ isAdmin, addToast }: any) {
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [runningNow, setRunningNow] = useState(false);

  const load = async () => {
    try {
      const r = await fetch('/api/backup/status');
      const d = await r.json();
      if (r.ok) setStatus(d);
    } catch (_) {}
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const runNow = async () => {
    setRunningNow(true);
    try {
      const r = await fetch('/api/backup/run', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `Сервер ответил ${r.status}`);
      addToast(`Архив создан: файлов Проводника — ${d.explorerFiles}, книг данных — ${d.dataWorkbooks}`, 'success');
      load();
    } catch (e: any) {
      addToast(`Не удалось создать архив: ${e.message}`, 'error');
    } finally {
      setRunningNow(false);
    }
  };

  const saveSettings = async (patch: any) => {
    try {
      const r = await fetch('/api/backup/settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'ошибка');
      setStatus((prev: any) => prev ? { ...prev, settings: d.settings } : prev);
      addToast('Настройки резервных копий сохранены', 'success');
      load();
    } catch (e: any) {
      addToast(`Не удалось сохранить: ${e.message}`, 'error');
    }
  };

  const fmtSize = (bytes: number) => {
    if (!bytes) return '—';
    const mb = bytes / (1024 * 1024);
    return mb >= 1 ? `${mb.toFixed(1)} МБ` : `${Math.round(bytes / 1024)} КБ`;
  };

  if (loading) return <SectionShell title="Резервные копии" desc="Загрузка…"><Loader2 className="w-5 h-5 animate-spin text-emerald-600" /></SectionShell>;

  const settings = status?.settings || { enabled: true, dir: '', keep: 14 };
  const backups = status?.backups || [];

  return (
    <SectionShell title="Резервные копии" desc="Ежедневный архив: база, файлы Проводника и данные проектов.">
      <div className="space-y-5">
        {/* Статус и ручной запуск */}
        <div className="p-4 rounded-xl border border-slate-150 dark:border-slate-850 bg-slate-50/50 dark:bg-slate-900/30 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <div className="text-xs font-bold uppercase tracking-wider text-slate-400">Папка архивов</div>
              <div className="text-xs font-mono mt-1 text-slate-600 dark:text-slate-300 select-all break-all">{status?.dir || '—'}</div>
            </div>
            {isAdmin && (
              <button type="button"
                onClick={runNow}
                disabled={runningNow || status?.running}
                className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-xs font-bold cursor-pointer"
              >
                {runningNow ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />}
                {runningNow ? 'Создание архива…' : 'Создать архив сейчас'}
              </button>
            )}
          </div>
          <div className="text-xs text-slate-400 leading-relaxed">
            Внутри каждого архива: <span className="font-mono">database.sqlite</span> (вся база),
            папка <span className="font-mono">Проводник</span> (файлы как есть, по проектам и папкам),
            папка <span className="font-mono">Данные</span> (Excel-книги: теги, закупки, оборудование).
            Дополнительно при каждом запуске программы делается быстрая страховочная копия базы (хранятся 5 последних).
          </div>
        </div>

        {/* Настройки */}
        <div className="p-4 rounded-xl border border-slate-150 dark:border-slate-850 bg-slate-50/50 dark:bg-slate-900/30 space-y-3">
          <div className="text-xs font-bold uppercase tracking-wider text-slate-400">Расписание</div>
          <label className="flex items-center gap-2 text-xs font-semibold text-slate-600 dark:text-slate-300 cursor-pointer select-none">
            <input
              type="checkbox"
              disabled={!isAdmin}
              checked={!!settings.enabled}
              onChange={(e) => saveSettings({ enabled: e.target.checked })}
              className="w-4 h-4 accent-emerald-500 cursor-pointer"
            />
            Делать архив автоматически каждый день
          </label>
          <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
            <span>Хранить архивов:</span>
            <input
              type="number" min={1} max={90}
              disabled={!isAdmin}
              defaultValue={settings.keep}
              onBlur={(e) => { const v = Number(e.target.value); if (v && v !== settings.keep) saveSettings({ keep: v }); }}
              className="w-20 px-2 py-1.5 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-xs text-center"
            />
            <span className="text-slate-400">(старые удаляются сами)</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
            <span className="shrink-0">Своя папка:</span>
            <input
              type="text"
              disabled={!isAdmin}
              defaultValue={settings.dir || ''}
              placeholder="пусто = стандартная в папке данных программы"
              onBlur={(e) => { const v = e.target.value.trim(); if (v !== (settings.dir || '')) saveSettings({ dir: v }); }}
              className="flex-1 min-w-0 px-2 py-1.5 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-mono"
            />
          </div>
          <p className="text-2xs text-amber-600 dark:text-amber-400">
            Совет: укажите папку на другом диске или сетевом хранилище — тогда архив переживёт даже поломку диска с программой.
          </p>
        </div>

        {/* Список архивов */}
        <div>
          <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-1.5">
            <FolderOpen className="w-3.5 h-3.5" /> Существующие архивы ({backups.length})
          </div>
          {backups.length === 0 ? (
            <p className="text-xs text-slate-400">Архивов ещё нет — первый создастся автоматически в течение часа, или нажмите «Создать архив сейчас».</p>
          ) : (
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {backups.map((b: any) => (
                <div key={b.name} className="flex items-center justify-between px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-150 dark:border-slate-850 text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <Archive className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                    <span className="font-mono font-bold truncate">{b.name}</span>
                  </div>
                  <div className="flex items-center gap-3 text-slate-400 shrink-0">
                    {b.manifest && <span title={`Файлов Проводника: ${b.manifest.explorerFiles}, книг данных: ${b.manifest.dataWorkbooks}`}>{countOf(b.manifest.explorerFiles, 'файл')}</span>}
                    <span>{fmtSize(b.size)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </SectionShell>
  );
}

// ── Оборудование ───────────────────────────────────────────────────────────────
function EquipmentSection({ isAdmin, addToast }: any) {
  const [conflictMode, setConflictMode] = useState<'immediate' | 'wait'>('wait');
  const [categories, setCategories] = useState<Array<{ id: string; label: string; composite?: boolean }>>([]);
  const [newCat, setNewCat] = useState('');

  useEffect(() => {
    fetch('/api/settings/equip_conflict_mode').then(r => r.json()).then(d => {
      if (d.global === 'immediate') setConflictMode('immediate');
    }).catch(() => {});
    fetch('/api/equipment/categories').then(r => r.json()).then(d => {
      if (Array.isArray(d.categories)) setCategories(d.categories);
    }).catch(() => {});
  }, []);

  const saveConflictMode = async (m: 'immediate' | 'wait') => {
    setConflictMode(m);
    await fetch('/api/settings/equip_conflict_mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: null, value: m }) }).catch(() => {});
  };

  const saveCategories = async (next: any[]) => {
    setCategories(next);
    await fetch('/api/equipment/categories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ categories: next }) }).catch(() => {});
  };

  return (
    <SectionShell title="Оборудование" desc="Поведение при импорте новых ревизий и категории оборудования.">
      <div className="space-y-5">
        <div className="p-4 rounded-xl border border-slate-150 dark:border-slate-850 bg-slate-50/50 dark:bg-slate-900/30">
          <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">При новой ревизии</div>
          <div className="flex gap-2 max-w-md">
            <button type="button" onClick={() => saveConflictMode('wait')} className={`flex-1 py-2 rounded-lg border text-xs font-semibold cursor-pointer ${conflictMode === 'wait' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white dark:bg-slate-950 border-slate-200 dark:border-slate-800'}`}>Ждать решения (✓/✎)</button>
            <button type="button" onClick={() => saveConflictMode('immediate')} className={`flex-1 py-2 rounded-lg border text-xs font-semibold cursor-pointer ${conflictMode === 'immediate' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white dark:bg-slate-950 border-slate-200 dark:border-slate-800'}`}>Изменять сразу</button>
          </div>
        </div>

        <div className="p-4 rounded-xl border border-slate-150 dark:border-slate-850 bg-slate-50/50 dark:bg-slate-900/30">
          <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">Категории оборудования</div>
          <div className="space-y-1 mb-2 max-h-52 overflow-y-auto max-w-md">
            {categories.map(c => (
              <div key={c.id} className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-white dark:bg-slate-950 border border-slate-150 dark:border-slate-850 text-xs">
                <span>{c.label}</span>
                {isAdmin && !['AHU', 'FAN', 'VALVE', 'CURTAIN'].includes(c.id) && (
                  <button type="button" onClick={() => saveCategories(categories.filter(x => x.id !== c.id))} className="text-slate-400 hover:text-rose-500 cursor-pointer"><Trash2 className="w-3.5 h-3.5" /></button>
                )}
              </div>
            ))}
          </div>
          {isAdmin && (
            <div className="flex gap-2 max-w-md">
              <input value={newCat} onChange={e => setNewCat(e.target.value)} placeholder="Новая категория…" className="flex-1 min-w-0 px-3 py-2 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-xs focus:outline-none focus:border-emerald-500" />
              <button type="button"
                onClick={() => {
                  const label = newCat.trim();
                  if (!label) return;
                  saveCategories([...categories, { id: 'C' + Date.now(), label, composite: false }]);
                  setNewCat('');
                  addToast('Категория добавлена', 'success');
                }}
                className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold cursor-pointer"
              >
                Добавить
              </button>
            </div>
          )}
        </div>
      </div>
    </SectionShell>
  );
}

// Переиспользуемый выбор способа связи «Кликом / Перетаскиванием»
function LinkModeChooser({ value, onChange, clickDesc, dragDesc }: {
  value: 'click' | 'drag'; onChange: (m: 'click' | 'drag') => void; clickDesc: string; dragDesc: string;
}) {
  const opt = (mode: 'click' | 'drag', icon: React.ReactNode, title: string, desc: string) => (
    <button type="button"
      onClick={() => onChange(mode)}
      className={`flex-1 p-4 rounded-xl border text-left cursor-pointer transition-colors ${
        value === mode
          ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-400 dark:border-emerald-700 ring-2 ring-emerald-500/30'
          : 'bg-white dark:bg-slate-950 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
      }`}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`w-8 h-8 rounded-lg flex items-center justify-center ${value === mode ? 'bg-emerald-600 text-white' : 'bg-slate-100 dark:bg-slate-900 text-slate-500'}`}>{icon}</span>
        <span className="text-sm font-bold text-slate-800 dark:text-slate-100">{title}</span>
        {value === mode && <Check className="w-4 h-4 text-emerald-600 ml-auto" />}
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">{desc}</p>
    </button>
  );
  return (
    <div className="flex gap-3 max-w-xl flex-col @[640px]:flex-row">
      {opt('click', <MousePointerClick className="w-4 h-4" />, 'Кликом', clickDesc)}
      {opt('drag', <Link2 className="w-4 h-4" />, 'Перетаскиванием', dragDesc)}
    </div>
  );
}

// ── Раздел «Теги»: подразделы «Схема» и «Дерево» ─────────────────────────────
function TagsSection({ addToast }: any) {
  const [canvasMode, setCanvasMode] = useState<'click' | 'drag'>('click');
  const [treeMode, setTreeMode] = useState<'click' | 'drag'>('click');

  useEffect(() => {
    fetch('/api/settings/registry_link_mode').then(r => r.json()).then(d => {
      if (d.global === 'drag' || d.global === 'click') setCanvasMode(d.global);
    }).catch(() => {});
    fetch('/api/settings/tree_link_mode').then(r => r.json()).then(d => {
      if (d.global === 'drag' || d.global === 'click') setTreeMode(d.global);
    }).catch(() => {});
  }, []);

  const save = async (key: 'registry_link_mode' | 'tree_link_mode', m: 'click' | 'drag') => {
    if (key === 'registry_link_mode') setCanvasMode(m); else setTreeMode(m);
    await fetch(`/api/settings/${key}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: null, value: m }),
    }).catch(() => {});
    try { window.dispatchEvent(new CustomEvent('flux:settings-changed', { detail: { key, value: m } })); } catch (_) {}
    addToast?.('Способ создания связей сохранён', 'success');
  };

  return (
    <SectionShell title="Теги" desc="Настройки раздела «Теги»: способ создания связей на холсте и в дереве.">
      <div className="space-y-5">
        <div className="p-4 rounded-xl border border-slate-150 dark:border-slate-850 bg-slate-50/50 dark:bg-slate-900/30">
          <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">Схема · подключение связей</div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">Как соединять теги на холсте.</p>
          <LinkModeChooser
            value={canvasMode}
            onChange={(m) => save('registry_link_mode', m)}
            clickDesc="Кнопка «связать» на карточке → клик по целевому тегу. Минимум точности, удобно мышью."
            dragDesc="Точки-порты по краям карточки: тянешь линию от одного тега к другому."
          />
        </div>

        <div className="p-4 rounded-xl border border-slate-150 dark:border-slate-850 bg-slate-50/50 dark:bg-slate-900/30">
          <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">Дерево · подключение связей</div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">Как соединять теги во вкладке «Дерево связей».</p>
          <LinkModeChooser
            value={treeMode}
            onChange={(m) => save('tree_link_mode', m)}
            clickDesc="Кнопка «связать» у строки → клик по строке-получателю. Она станет дочерней."
            dragDesc="Перетаскиваешь строку тега на другую — перетащенный становится дочерним."
          />
        </div>
      </div>
    </SectionShell>
  );
}

// ── База данных (перенесено из профиля) ────────────────────────────────────────
function DatabaseSection({ addToast }: any) {
  const { user } = useStore();
  const isAdmin = user?.role === 'ADMIN';
  const [dbLocation, setDbLocation] = useState('');
  const [dbDisplayLocation, setDbDisplayLocation] = useState('');
  const [dbType, setDbType] = useState<'LOCAL' | 'REMOTE' | string>('LOCAL');
  const [activeDbType, setActiveDbType] = useState<'LOCAL' | 'REMOTE' | string>('LOCAL');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ text: string; success: boolean } | null>(null);

  const handleSyncSchema = async () => {
    setIsSyncing(true);
    setStatusMessage(null);
    try {
      const resp = await fetch(`${ENV_CONFIG.apiUrl}/admin/sync-schema`, { method: 'POST' });
      const d = await resp.json();
      if (resp.ok) setStatusMessage({ text: d.message || 'Готово', success: true });
      else setStatusMessage({ text: d.error || 'Не удалось проверить структуру', success: false });
    } catch (e: any) {
      setStatusMessage({ text: e?.message || 'Ошибка', success: false });
    } finally {
      setIsSyncing(false);
    }
  };

  const refresh = async () => {
    try {
      const resp = await fetch(`${ENV_CONFIG.apiUrl}/db/config`.replace('/api/api', '/api'));
      const config = await resp.json();
      setDbLocation(config.databasePath);
      setDbDisplayLocation(config.displayPath || config.databasePath);
      setDbType(config.current_db_type || 'LOCAL');
      setActiveDbType(config.current_db_type || 'LOCAL');
      setRemoteUrl(config.database_url || '');
    } catch (_) {}
  };

  useEffect(() => { refresh(); }, []);

  const handleSwitch = async (targetType: string, urlKey: string, dbPath?: string) => {
    setIsSaving(true);
    setStatusMessage(null);
    try {
      const resp = await fetch(`${ENV_CONFIG.apiUrl}/db/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          current_db_type: targetType,
          database_url: urlKey,
          ...(typeof dbPath === 'string' ? { database_path: dbPath } : {})
        })
      });
      const data = await resp.json();
      if (data.success) {
        setStatusMessage({ text: data.message, success: true });
        await refresh();
        void openAlert('Подключение обновлено', data.message || 'Программа работает с новой базой данных.');
        window.location.reload();
      } else {
        setStatusMessage({ text: data.message || 'Ошибка подключения!', success: false });
      }
    } catch (err: any) {
      setStatusMessage({ text: `Ошибка запроса: ${err.message}`, success: false });
    } finally {
      setIsSaving(false);
    }
  };

  const handlePickDbFile = async () => {
    const win = window as any;
    if (!win.electron?.ipcRenderer?.invoke) {
      void openAlert('Доступно только в программе', 'Выбрать файл можно в установленном приложении Flux — в браузере эта возможность недоступна.');
      return;
    }
    try {
      const filePath = await win.electron.ipcRenderer.invoke('database:select-file');
      if (filePath) await handleSwitch('LOCAL', '', String(filePath));
    } catch (err: any) {
      setStatusMessage({ text: `Ошибка выбора файла: ${err.message}`, success: false });
    }
  };

  const handleTest = async () => {
    setIsTesting(true);
    setStatusMessage(null);
    try {
      const resp = await fetch(`${ENV_CONFIG.apiUrl}/db/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_db_type: dbType, database_url: remoteUrl })
      });
      const data = await resp.json();
      setStatusMessage({ text: data.message, success: !!data.success });
    } catch (err: any) {
      setStatusMessage({ text: `Ошибка при проверке: ${err.message}`, success: false });
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <SectionShell title="База данных" desc="Локальная SQLite (работает автономно) или сетевой PostgreSQL для совместной работы.">
      <div className="max-w-lg space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => setDbType('LOCAL')} className={`py-2 rounded-xl border text-sm font-semibold cursor-pointer ${dbType === 'LOCAL' ? 'bg-emerald-600 text-white border-emerald-700' : 'bg-white dark:bg-slate-950 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-800'}`}>Локальная</button>
          <button type="button" onClick={() => setDbType('REMOTE')} className={`py-2 rounded-xl border text-sm font-semibold cursor-pointer ${dbType === 'REMOTE' ? 'bg-emerald-600 text-white border-emerald-700' : 'bg-white dark:bg-slate-950 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-800'}`}>Сеть / PostgreSQL</button>
        </div>

        {dbType === 'LOCAL' ? (
          <div className="space-y-2">
            <p className="font-mono text-xs text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-900 p-2.5 border border-slate-200 dark:border-slate-800 rounded-lg select-all break-all" title={dbLocation}>
              {dbDisplayLocation || 'database.sqlite'}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" disabled={isSaving} onClick={handlePickDbFile} className="py-2 rounded-lg bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-300 cursor-pointer disabled:opacity-50">Выбрать файл БД…</button>
              <button type="button" disabled={isSaving} onClick={async () => { if (await openConfirm('Вернуть базу в стандартную папку?', 'Программа снова будет работать с базой в папке AppData/pdm-app.', { confirmLabel: 'Вернуть' })) handleSwitch('LOCAL', '', ''); }} className="py-2 rounded-lg bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-300 cursor-pointer disabled:opacity-50">Стандартный путь</button>
            </div>
            <button type="button" disabled={isSaving} onClick={() => handleSwitch('LOCAL', '')} className="w-full py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold cursor-pointer disabled:opacity-50">
              {isSaving ? 'Подключение…' : activeDbType === 'LOCAL' ? 'Локальный режим активен ✓' : 'Включить локальный режим'}
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <input
              type="text"
              value={remoteUrl}
              onChange={(e) => setRemoteUrl(e.target.value)}
              placeholder="mysql://user:password@host:3306/flux или postgresql://user:password@host:5432/flux"
              className="w-full font-mono text-xs bg-white dark:bg-slate-950 text-slate-800 dark:text-slate-100 p-2.5 border border-slate-200 dark:border-slate-800 rounded-lg outline-none focus:border-emerald-500"
            />
            <p className="text-xs text-slate-500 dark:text-slate-400">MariaDB/MySQL — адрес mysql://…, PostgreSQL — postgresql://…</p>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" disabled={isTesting} onClick={handleTest} className="py-2 rounded-lg bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-300 cursor-pointer disabled:opacity-50">
                {isTesting ? 'Проверка…' : 'Тестировать'}
              </button>
              <button type="button" disabled={isSaving} onClick={() => handleSwitch('REMOTE', remoteUrl)} className="py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold cursor-pointer disabled:opacity-50">
                {isSaving ? 'Загрузка…' : 'Сохранить и подключить'}
              </button>
            </div>
          </div>
        )}

        {statusMessage && (
          <div className={`p-2 text-xs font-bold text-center rounded-lg ${statusMessage.success ? 'bg-emerald-50 dark:bg-emerald-950/20 text-emerald-600' : 'bg-rose-50 dark:bg-rose-950/20 text-rose-600'}`}>
            {statusMessage.text}
          </div>
        )}

        {isAdmin && (
          <div className="pt-3 mt-1 border-t border-slate-200 dark:border-slate-800 space-y-1.5">
            <button type="button" disabled={isSyncing} onClick={handleSyncSchema} className="w-full py-2.5 rounded-lg bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-300 cursor-pointer disabled:opacity-50">
              {isSyncing ? 'Проверка…' : 'Проверить / обновить структуру базы'}
            </button>
            <p className="text-xs text-slate-500 dark:text-slate-400">Достраивает недостающие таблицы и колонки после обновления программы.</p>
          </div>
        )}
      </div>
    </SectionShell>
  );
}

// ── Формулы документа ─────────────────────────────────────────────────────
// Справочник открывается тем же компонентом, что и из панели вставки в титуле:
// разошедшиеся карточки настройки означали бы, что формула, собранная в одном
// месте, ведёт себя иначе в другом.
function FormulasSection() {
  const activeProject = useStore((st: any) => st.activeProject);
  if (!activeProject?.id) {
    return (
      <SectionShell title="Формулы документа" desc="Именованные значения для титульного листа.">
        <div className="blank">
          <div className="blank-title">Проект не выбран</div>
          <div className="blank-text">
            Формулы принадлежат проекту: у каждого свои шифры, ревизии и подписанты.
            Выберите проект — справочник откроется.
          </div>
        </div>
      </SectionShell>
    );
  }
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-xl font-bold text-slate-900 dark:text-white">Формулы документа</h2>
        {/* Чей это набор. Без подписи люди правили формулы, будучи уверены,
            что правят их для всей программы, а правили для одного проекта. */}
        <span className="text-2xs font-semibold px-2 py-0.5 rounded-full max-w-[220px] truncate
                         bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300
                         border border-emerald-200 dark:border-emerald-900"
              title="Формулы свои у каждого проекта">
          проект «{activeProject.name}»
        </span>
      </div>
      <p className="text-xs text-slate-400 mt-1 mb-4">
        Что видно в титуле вместо выражения: «Дата», «Инициалы сотрудника», «Подпись»,
        «Шифр с ревизией». Настройка живёт здесь, документ показывает только название.
      </p>
      <div className="flex-1 min-h-0 sheet">
        <FormulaManager projectId={activeProject.id} />
      </div>
    </div>
  );
}

// ── Документооборот: глобальные стандарты ВДР ──
// Хранятся в программе один раз, применяются к реестрам любых проектов
// (выбор — в реквизитах реестра). Здесь правятся коды рассмотрения со сроками,
// причины выпуска, спец-ревизии и каталог типов документов.
function DocflowSection({ isAdmin, addToast }: any) {
  const [standards, setStandards] = React.useState<any[]>([]);
  const [selId, setSelId] = React.useState('');
  const [cfg, setCfg] = React.useState<any>(null);
  const [name, setName] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const load = async () => {
    try {
      const r = await fetch('/api/vdr/standards');
      if (!r.ok) return;
      const list = (await r.json()).standards || [];
      setStandards(list);
      const sel = list.find((s: any) => s.id === selId) || list[0];
      if (sel) { setSelId(sel.id); setCfg(JSON.parse(JSON.stringify(sel.config || {}))); setName(sel.name); }
    } catch (_) {}
  };
  React.useEffect(() => { load(); }, []);

  const pick = (id: string) => {
    const s = standards.find((x: any) => x.id === id);
    if (s) { setSelId(id); setCfg(JSON.parse(JSON.stringify(s.config || {}))); setName(s.name); }
  };

  const save = async () => {
    if (!selId) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/vdr/standards/${selId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, config: cfg }),
      });
      if (r.ok) { addToast('Стандарт сохранён', 'success'); load(); }
      else addToast('Ошибка сохранения', 'error');
    } finally { setBusy(false); }
  };

  const createStd = async () => {
    const n = await openPrompt('Новый стандарт документооборота', 'Название — обычно имя заказчика.', 'Например: Заказчик «Азот»', 'Новый стандарт');
    if (!n) return;
    const r = await fetch('/api/vdr/standards', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: n, config: cfg || undefined }),
    });
    if (r.ok) { const d = await r.json(); await load(); pick(d.standard.id); addToast('Стандарт создан (копия текущего)', 'success'); }
  };

  const removeStd = async () => {
    if (!selId) return;
    if (!await openConfirm(`Удалить стандарт «${name}»?`, 'Реестры, которые им пользуются, перейдут на стандарт по умолчанию.', { confirmLabel: 'Удалить стандарт', tone: 'danger' })) return;
    const r = await fetch(`/api/vdr/standards/${selId}`, { method: 'DELETE' });
    if (r.ok) { setSelId(''); load(); } else addToast('Удалять может администратор', 'error');
  };

  const upd = (path: string, idx: number, key: string, val: any) => {
    setCfg((c: any) => {
      const next = { ...c, [path]: [...(c[path] || [])] };
      next[path][idx] = { ...next[path][idx], [key]: val };
      return next;
    });
  };
  const addRow = (path: string, row: any) => setCfg((c: any) => ({ ...c, [path]: [...(c[path] || []), row] }));
  const delRow = (path: string, idx: number) => setCfg((c: any) => ({ ...c, [path]: (c[path] || []).filter((_: any, i: number) => i !== idx) }));

  const inp = 'px-2 py-1 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-800 dark:text-white focus:outline-none focus:border-emerald-500';

  if (!cfg) return <SectionShell title="Документооборот" desc="Стандарты ВДР."><div className="text-sm text-slate-400">Загрузка…</div></SectionShell>;

  return (
    <SectionShell title="Документооборот" desc="Глобальные стандарты ВДР: применяются к реестрам любых проектов (выбор — в реквизитах реестра).">
      <div className="space-y-4 max-w-3xl">
        <div className="flex items-center gap-2">
          <select value={selId} onChange={e => pick(e.target.value)} className={inp + ' cursor-pointer font-semibold'}>
            {standards.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input value={name} onChange={e => setName(e.target.value)} className={inp + ' flex-1'} placeholder="Название стандарта" />
          <button type="button" onClick={createStd} className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer">+ Новый</button>
          {isAdmin && <button type="button" title="Удалить стандарт" onClick={removeStd} className="p-1.5 rounded-lg text-slate-400 hover:text-rose-500 cursor-pointer"><Trash2 className="w-3.5 h-3.5" /></button>}
        </div>

        {/* Коды рассмотрения */}
        <div>
          <div className="text-xs font-bold text-slate-600 dark:text-slate-300 mb-1.5">Коды рассмотрения заказчика (действие и срок новой ревизии)</div>
          <div className="space-y-1">
            {(cfg.reviewCodes || []).map((c: any, i: number) => (
              <div key={i} className="flex items-center gap-1.5">
                <input value={c.code} onChange={e => upd('reviewCodes', i, 'code', e.target.value)} className={inp + ' w-12 text-center font-bold'} />
                <input value={c.label} onChange={e => upd('reviewCodes', i, 'label', e.target.value)} className={inp + ' flex-1'} />
                <select value={c.action} onChange={e => upd('reviewCodes', i, 'action', e.target.value)} className={inp + ' cursor-pointer'}>
                  <option value="accept">принят</option>
                  <option value="revise">замечания</option>
                </select>
                <input type="number" value={c.deadlineDays ?? ''} onChange={e => upd('reviewCodes', i, 'deadlineDays', Number(e.target.value) || 0)} className={inp + ' w-16 text-center'} title="Срок новой ревизии, дней" />
                <span className="text-2xs text-slate-400">дн.</span>
                <button type="button" onClick={() => delRow('reviewCodes', i)} className="p-1 text-slate-300 hover:text-rose-500 cursor-pointer"><X className="w-3 h-3" /></button>
              </div>
            ))}
          </div>
          <button type="button" onClick={() => addRow('reviewCodes', { code: '', label: '', action: 'revise', deadlineDays: 7 })} className="mt-1.5 text-xs font-bold text-emerald-600 hover:text-emerald-700 cursor-pointer">+ код</button>
        </div>

        {/* Причины выпуска */}
        <div>
          <div className="text-xs font-bold text-slate-600 dark:text-slate-300 mb-1.5">Причины выпуска (буквенные/цифровые ревизии)</div>
          <div className="space-y-1">
            {(cfg.reasons || []).map((r: any, i: number) => (
              <div key={i} className="flex items-center gap-1.5">
                <input value={r.code} onChange={e => upd('reasons', i, 'code', e.target.value)} className={inp + ' w-16 text-center font-bold'} />
                <input value={r.label} onChange={e => upd('reasons', i, 'label', e.target.value)} className={inp + ' flex-1'} />
                <select value={r.revKind} onChange={e => upd('reasons', i, 'revKind', e.target.value)} className={inp + ' cursor-pointer'}>
                  <option value="letter">A, B, C…</option>
                  <option value="digit">0, 1, 2…</option>
                </select>
                <button type="button" onClick={() => delRow('reasons', i)} className="p-1 text-slate-300 hover:text-rose-500 cursor-pointer"><X className="w-3 h-3" /></button>
              </div>
            ))}
          </div>
          <button type="button" onClick={() => addRow('reasons', { code: '', label: '', revKind: 'letter' })} className="mt-1.5 text-xs font-bold text-emerald-600 hover:text-emerald-700 cursor-pointer">+ причина</button>
        </div>

        {/* Маски и спец-ревизии */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-xs font-bold text-slate-600 dark:text-slate-300 mb-1">Маска имени файла</div>
            <input value={cfg.fileNameMask || ''} onChange={e => setCfg((c: any) => ({ ...c, fileNameMask: e.target.value }))} className={inp + ' w-full'} placeholder="{docNo}_{rev}_{lang}" />
          </div>
          <div>
            <div className="text-xs font-bold text-slate-600 dark:text-slate-300 mb-1">Маска номера документа</div>
            <input value={cfg.docNumberMask || ''} onChange={e => setCfg((c: any) => ({ ...c, docNumberMask: e.target.value }))} className={inp + ' w-full'} placeholder="{contract}-{wbs}-{po}-{type}-{seq}" />
          </div>
          <div>
            <div className="text-xs font-bold text-slate-600 dark:text-slate-300 mb-1">Ревизия «аннулирован»</div>
            <input value={cfg.specialRevisions?.void || 'V'} onChange={e => setCfg((c: any) => ({ ...c, specialRevisions: { ...c.specialRevisions, void: e.target.value } }))} className={inp + ' w-16 text-center font-bold'} />
          </div>
          <div>
            <div className="text-xs font-bold text-slate-600 dark:text-slate-300 mb-1">Ревизия «заменён»</div>
            <input value={cfg.specialRevisions?.superseded || 'S'} onChange={e => setCfg((c: any) => ({ ...c, specialRevisions: { ...c.specialRevisions, superseded: e.target.value } }))} className={inp + ' w-16 text-center font-bold'} />
          </div>
        </div>

        {/* Каталог типов */}
        <div>
          <div className="text-xs font-bold text-slate-600 dark:text-slate-300 mb-1.5">Каталог типов документов (VDR-коды)</div>
          <div className="space-y-1 max-h-56 overflow-auto pr-1">
            {(cfg.vdrTypes || []).map((t: any, i: number) => (
              <div key={i} className="flex items-center gap-1.5">
                <input value={t.code} onChange={e => upd('vdrTypes', i, 'code', e.target.value)} className={inp + ' w-16 text-center font-bold'} />
                <input value={t.titleEn} onChange={e => upd('vdrTypes', i, 'titleEn', e.target.value)} className={inp + ' flex-1'} placeholder="English title" />
                <input value={t.titleRu} onChange={e => upd('vdrTypes', i, 'titleRu', e.target.value)} className={inp + ' flex-1'} placeholder="Название" />
                <button type="button" onClick={() => delRow('vdrTypes', i)} className="p-1 text-slate-300 hover:text-rose-500 cursor-pointer"><X className="w-3 h-3" /></button>
              </div>
            ))}
          </div>
          <button type="button" onClick={() => addRow('vdrTypes', { code: '', titleEn: '', titleRu: '' })} className="mt-1.5 text-xs font-bold text-emerald-600 hover:text-emerald-700 cursor-pointer">+ тип</button>
        </div>

        <button type="button" onClick={save} disabled={busy} className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-bold cursor-pointer">
          {busy ? 'Сохраняю…' : 'Сохранить стандарт'}
        </button>
      </div>
    </SectionShell>
  );
}

// ── Роли сотрудников ───────────────────────────────────────────────────────────
// Роли перестали быть четырьмя строками в коде: их заводит главный
// администратор (уровень 1), и они видны везде, где показан сотрудник.
// Остальные роли доступ не раздают — иначе право можно было бы выписать себе,
// придумав новую роль.
function RolesSection({ user, addToast }: { user: any; addToast: (m: string, t?: any) => void }) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Role | null>(null);
  const [draft, setDraft] = useState<Partial<Role> | null>(null);
  const [busy, setBusy] = useState(false);
  const top = isTopAdmin(user, roles);

  const reload = async (force = true) => {
    setLoading(true);
    const list = await loadRoles(force);
    setRoles(list);
    setLoading(false);
  };
  useEffect(() => { reload(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const api = async (path: string, method: string, body?: any) => {
    const token = getAuthToken();
    const res = await fetch(`${ENV_CONFIG.apiUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Не удалось выполнить действие');
    return data;
  };

  const startNew = () => {
    setEditing(null);
    setDraft({ name: '', code: '', description: '', color: 'sky', icon: 'user', level: 50 });
  };

  const save = async () => {
    if (!draft) return;
    const name = String(draft.name || '').trim();
    if (!name) { addToast('Укажите название роли', 'error'); return; }
    setBusy(true);
    try {
      if (editing) await api(`/roles/${editing.id}`, 'PUT', draft);
      else await api('/roles', 'POST', draft);
      invalidateRoles();
      await reload();
      setDraft(null); setEditing(null);
      addToast(editing ? 'Роль обновлена' : `Роль «${name}» создана`, 'success');
    } catch (e: any) {
      addToast(e.message, 'error');
    } finally { setBusy(false); }
  };

  const remove = async (r: Role) => {
    setBusy(true);
    try {
      await api(`/roles/${r.id}`, 'DELETE');
      invalidateRoles();
      await reload();
      addToast(`Роль «${r.name}» удалена`, 'success');
    } catch (e: any) {
      addToast(e.message, 'error');
    } finally { setBusy(false); }
  };

  return (
    <SectionShell title="Роли сотрудников" desc="Кем работают люди в программе.">
      {!top && (
        <div className="mb-4 flex items-start gap-2 p-3 rounded-xl border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/20 text-amber-800 dark:text-amber-300 text-xs">
          <Lock className="w-4 h-4 shrink-0 mt-0.5" />
          <span>Роли создаёт и меняет только главный администратор (уровень 1). Здесь вы видите текущий список.</span>
        </div>
      )}

      <div className="space-y-2">
        {loading && <div className="text-xs text-slate-400 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Загружаю роли…</div>}
        {roles.map((r) => (
          <div key={r.id} className="flex items-center gap-3 p-3 rounded-xl border border-slate-200 dark:border-slate-850 bg-white dark:bg-slate-950">
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border shrink-0 ${roleColorClass(r.color)}`}>
              <RoleIcon name={r.icon} className="w-3.5 h-3.5" />
              {r.name}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-xs text-slate-500 dark:text-slate-400 truncate">{r.description || 'Без описания'}</div>
              <div className="text-2xs font-mono text-slate-400 mt-0.5">
                {r.code} · уровень {r.level}
                {r.level > 1 && ` · прав: ${Object.values(parsePermissions(r.permissions as any)).filter((e: any) => e?.enabled).length}`}
                {r.level <= 1 && ' — главный администратор'}
                {r.isSystem && ' · встроенная'}
              </div>
            </div>
            {top && (
              <div className="flex items-center gap-1 shrink-0">
                <button type="button" disabled={busy}
                  onClick={() => { setEditing(r); setDraft({ ...r }); }}
                  className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-900 text-slate-500 cursor-pointer" title="Изменить роль">
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button type="button" disabled={busy || r.isSystem}
                  onClick={() => remove(r)}
                  className={`p-1.5 rounded-lg cursor-pointer ${r.isSystem
                    ? 'text-slate-400 dark:text-slate-455 cursor-not-allowed'
                    : 'hover:bg-rose-50 dark:hover:bg-rose-950/30 text-rose-500'}`}
                  title={r.isSystem ? 'Встроенную роль удалить нельзя' : 'Удалить роль'}>
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {top && !draft && (
        <button type="button" onClick={startNew}
          className="mt-4 inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold transition-ui cursor-pointer">
          <Plus className="w-4 h-4" /> Добавить роль
        </button>
      )}

      {top && draft && (
        <div className="mt-4 p-4 rounded-xl border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50/40 dark:bg-emerald-950/20 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">
              {editing ? `Роль «${editing.name}»` : 'Новая роль'}
            </h3>
            <button type="button" onClick={() => { setDraft(null); setEditing(null); }}
              className="p-1 rounded-lg hover:bg-white/60 dark:hover:bg-slate-900 text-slate-400 cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 @[640px]:grid-cols-2 gap-3">
            <div>
              <label className="block text-2xs font-semibold text-slate-500 uppercase tracking-widest mb-1">Название</label>
              <input type="text" value={draft.name || ''} autoFocus
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Инженер-конструктор"
                className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
            </div>
            <div>
              <label className="block text-2xs font-semibold text-slate-500 uppercase tracking-widest mb-1">Код</label>
              <input type="text" value={draft.code || ''} disabled={!!editing}
                onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })}
                placeholder="ENGINEER_CAD"
                className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-sm font-mono disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
              <p className="text-2xs text-slate-400 mt-1">Латиницей. Пусто — программа придумает сама. Потом не меняется.</p>
            </div>
          </div>

          <div>
            <label className="block text-2xs font-semibold text-slate-500 uppercase tracking-widest mb-1">Описание</label>
            <input type="text" value={draft.description || ''}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="Чем занимается: разделы, зона ответственности"
              className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
          </div>

          <div className="grid grid-cols-1 @[640px]:grid-cols-2 gap-3">
            <div>
              <label className="block text-2xs font-semibold text-slate-500 uppercase tracking-widest mb-1.5">Цвет значка</label>
              <div className="flex flex-wrap gap-1.5">
                {ROLE_COLORS.map((c) => (
                  <button key={c.id} type="button" title={c.label}
                    onClick={() => setDraft({ ...draft, color: c.id })}
                    className={`w-7 h-7 rounded-lg ${c.dot} transition-ui cursor-pointer ${
                      draft.color === c.id ? 'ring-2 ring-offset-2 dark:ring-offset-slate-950 ring-slate-500 scale-110' : 'opacity-70 hover:opacity-100'}`} />
                ))}
              </div>
            </div>
            <div>
              <label className="block text-2xs font-semibold text-slate-500 uppercase tracking-widest mb-1.5">Значок</label>
              <div className="flex flex-wrap gap-1.5">
                {ROLE_ICONS.map((ic) => (
                  <button key={ic} type="button"
                    onClick={() => setDraft({ ...draft, icon: ic })}
                    className={`w-7 h-7 rounded-lg border flex items-center justify-center transition-ui cursor-pointer ${
                      draft.icon === ic
                        ? 'bg-emerald-600 border-emerald-600 text-white'
                        : 'bg-white dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-slate-500 hover:border-emerald-500'}`}>
                    <RoleIcon name={ic} className="w-3.5 h-3.5" />
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Права роли: что можно всем, кто на этой должности. Личные права
              сотрудника накладываются поверх и сильнее — так можно забрать
              доступ у одного человека, не трогая всю роль. */}
          <div>
            <label className="block text-2xs font-semibold text-slate-500 uppercase tracking-widest mb-1.5">
              Что разрешено этой роли
            </label>
            <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
              {FEATURE_GROUPS.map((g) => (
                <div key={g}>
                  <div className="text-2xs font-mono uppercase tracking-wider text-slate-400 mb-1">{g}</div>
                  <div className="space-y-1">
                    {FEATURES.filter((f) => f.group === g).map((f) => {
                      const perms = parsePermissions(draft.permissions as any);
                      const on = !!perms[f.id]?.enabled;
                      return (
                        <button key={f.id} type="button"
                          onClick={() => {
                            const next: PermMap = { ...perms };
                            if (on) delete next[f.id];
                            else next[f.id] = { enabled: true, until: null };
                            setDraft({ ...draft, permissions: JSON.stringify(next) });
                          }}
                          className={`w-full flex items-start gap-2 p-2 rounded-lg border text-left transition-ui cursor-pointer ${
                            on
                              ? 'border-emerald-400 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/30'
                              : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 hover:border-slate-300'}`}>
                          <span className={`mt-0.5 shrink-0 w-4 h-4 rounded border flex items-center justify-center ${
                            on ? 'bg-emerald-600 border-emerald-600 text-white' : 'border-slate-300 dark:border-slate-700'}`}>
                            {on && <Check className="w-3 h-3" />}
                          </span>
                          <span className="min-w-0">
                            <span className="block text-xs font-semibold text-slate-800 dark:text-slate-100">
                              {f.label}
                              {f.risky && <span className="ml-1.5 text-2xs font-bold text-amber-600 dark:text-amber-400">осторожно</span>}
                            </span>
                            <span className="block text-2xs text-slate-500 dark:text-slate-400 mt-0.5">{f.desc}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between pt-1">
            <span className="text-2xs text-slate-400 max-w-[22rem]">
              Так роль будет выглядеть в списке сотрудников и в подписях документов.
            </span>
            <div className="flex items-center gap-2">
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${roleColorClass(draft.color)}`}>
                <RoleIcon name={draft.icon} className="w-3.5 h-3.5" />
                {draft.name || 'Название роли'}
              </span>
              <button type="button" onClick={save} disabled={busy}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold transition-ui cursor-pointer disabled:opacity-60">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                Сохранить
              </button>
            </div>
          </div>
        </div>
      )}
    </SectionShell>
  );
}

// Переключатель «включено/выключено», который живёт в localStorage и сообщает
// об изменении событием: так его слышат и главный экран, и рабочая область,
// не завися от того, где он нарисован.

