import { useState, useEffect } from 'react';
import SectionShell from './SectionShell';
import { Plus, Trash2, ChevronUp, ChevronDown, RotateCcw, Loader2, Check } from 'lucide-react';
import {
  ProcurementStage, StageTemplate, DEFAULT_STAGES, STAGE_ICONS, STAGE_COLORS, loadProcurementStages, saveProcurementStages, stageIcon, stageColor, loadStageTemplates, saveStageTemplates, emptyRules,
} from '../../lib/procurementStages';
import { useModalStore } from '../../store/modalStore';

// Диалоги программы вместо системных окон Windows
const { openConfirm } = useModalStore.getState();

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
            <div key={s.id} className="fx-set-row flex-wrap gap-2.5">
              {/* Порядок */}
              <div className="flex flex-col">
                <button type="button" disabled={!isAdmin || idx === 0} onClick={() => move(idx, -1)} className="p-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-white disabled:opacity-20 cursor-pointer"><ChevronUp className="w-3.5 h-3.5" /></button>
                <button type="button" disabled={!isAdmin || idx === stages.length - 1} onClick={() => move(idx, 1)} className="p-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-white disabled:opacity-20 cursor-pointer"><ChevronDown className="w-3.5 h-3.5" /></button>
              </div>

              <span className="w-6 text-center text-xs text-slate-400 tabular-nums">{idx + 1}</span>

              {/* Значок */}
              <div className="relative">
                <button type="button"
                  disabled={!isAdmin}
                  onClick={() => setEditingIconFor(editingIconFor === s.id ? null : s.id)}
                  className={`fx-ibtn ${c.color}`}
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
                className="fx-input flex-1 min-w-[140px]"
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
        <button type="button" onClick={addStage} className="fx-btn fx-btn-primary">
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
      <label className="fx-label block">{label}</label>
      <input
        disabled={disabled}
        defaultValue={values.join(', ')}
        placeholder={hint}
        onBlur={(e) => {
          const next = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
          if (JSON.stringify(next) !== JSON.stringify(values)) onChange(next);
        }}
        className="fx-input"
      />
    </div>
  );
}

export default function ManagementSection({ isAdmin, addToast }: any) {
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
        <div className="mb-4 fx-note fx-note-warn">
          Изменять этапы и шаблоны может администратор. Вы видите текущую настройку.
        </div>
      )}

      {/* Переключатель: стандартный набор + шаблоны */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="fx-segctl flex-wrap" role="group" aria-label="Набор этапов">
        <button type="button"
          onClick={() => setActiveId('default')}
          aria-pressed={activeId === 'default'}
        >
          Стандартные этапы
        </button>
        {templates.map(t => (
          <button type="button"
            key={t.id}
            onClick={() => setActiveId(t.id)}
            aria-pressed={activeId === t.id}
          >
            {t.name}
          </button>
        ))}
        </div>
        {isAdmin && (
          <button type="button"
            onClick={addTemplate}
            className="fx-btn fx-btn-quiet"
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
                className="fx-btn"
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
              className="fx-input flex-1"
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
          <div className="fx-set-group space-y-3">
            <div className="text-xs font-medium text-slate-400">Когда применяется (автоматически)</div>
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
            <div className="fx-group-title mb-1">Этапы шаблона</div>
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
