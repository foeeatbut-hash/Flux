/**
 * Настройки панели «Черновики» (лист «Settings»): вид, что показывать, кнопка и
 * открытие, действия. Хранятся на рабочем месте (draftsSettingsStore); строки
 * уплотнены до 36 px, остальное — компоненты настроек из 01-design.md, раздел 5.
 */
import React from 'react';
import { X } from 'lucide-react';
import { Select, SettingRow, Seg, Switch } from '../ui';
import { SORT_LABEL } from '../../lib/draftsPanel';
import { useDraftsSettings, type DraftsSettings } from '../../store/draftsSettingsStore';
import { IconButton } from './DraftsControls';

const GROUPS: Array<{ value: DraftsSettings['group']; label: string }> = [
  { value: 'none', label: 'Нет' }, { value: 'date', label: 'Дата' }, { value: 'project', label: 'Проект' }, { value: 'type', label: 'Тип' }, { value: 'state', label: 'Состояние' },
];
const SORTS = (['modified', 'created', 'name', 'size', 'type'] as const).map((value) => ({ value, label: SORT_LABEL[value] }));
const num = <T extends number>(values: readonly T[]) => values.map((value) => ({ value: String(value), label: String(value) }));

function Title({ children }: { children: React.ReactNode }) {
  return <h3 className="fx-group-title mt-2 first:mt-0">{children}</h3>;
}

export default function DraftsSettingsPanel({ style, onClose }: { style: React.CSSProperties; onClose: () => void }) {
  const s = useDraftsSettings();
  const set = s.set;
  return <section aria-label="Настройки панели" data-drafts-settings
    className="fx-glass fx-rise-in absolute flex flex-col overflow-hidden rounded-lg border border-[var(--flux-line)] text-[var(--flux-text)]" style={style}>
    <header className="flex h-9 shrink-0 items-center border-b border-[var(--flux-line)] pl-2.5 pr-1.5">
      <h2 className="flex-1 text-[13px] font-[600]">Настройки панели</h2>
      <IconButton label="Закрыть настройки" onClick={onClose}><X size={14} /></IconButton>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2 pt-2 [&_.fx-set-row]:!min-h-9 [&_.fx-set-row]:!py-1 [scrollbar-width:thin]">
      <Title>Вид</Title>
      <SettingRow title="Вид панели"><Seg label="Вид панели" value={s.view} onChange={(view) => set({ view })} options={[{ value: 'strip', label: 'Полоса' }, { value: 'compact', label: 'Компактная' }]} /></SettingRow>
      <SettingRow title="Полоса: ряды"><Seg label="Ряды полосы" value={String(s.rows)} onChange={(v) => set({ rows: Number(v) as 1 | 2 })} options={num([1, 2])} /></SettingRow>
      <SettingRow title="Полоса: значки"><Seg label="Размер значков" value={s.icons} onChange={(icons) => set({ icons })} options={[{ value: 'S', label: 'S' }, { value: 'M', label: 'M' }, { value: 'L', label: 'L' }]} /></SettingRow>
      <SettingRow title="Компактная: столбцы"><Seg label="Столбцы плиток" value={String(s.columns)} onChange={(v) => set({ columns: Number(v) as 3 | 4 | 5 | 6 })} options={num([3, 4, 5, 6])} /></SettingRow>
      <SettingRow title="Компактная: показ"><Seg label="Плитки или список" value={s.compactMode} onChange={(compactMode) => set({ compactMode })} options={[{ value: 'grid', label: 'Плитки' }, { value: 'list', label: 'Список' }]} /></SettingRow>
      <SettingRow title="Подписи групп"><Switch label="Подписи групп" checked={s.groupLabels} onChange={(groupLabels) => set({ groupLabels })} /></SettingRow>
      <SettingRow title="Точка состояния"><Switch label="Точка состояния" checked={s.dots} onChange={(dots) => set({ dots })} /></SettingRow>

      <Title>Что показывать</Title>
      <SettingRow title="Сортировка">
        <div className="flex items-center gap-1.5">
          <Select value={s.sort === 'project' ? 'modified' : s.sort} onChange={(sort) => set({ sort: sort as DraftsSettings['sort'] })} options={SORTS} className="!h-7 !w-28" aria-label="Сортировка" />
          <Seg label="Порядок" value={s.dir} onChange={(dir) => set({ dir })} options={[{ value: 'desc', label: '↓', hint: 'По убыванию' }, { value: 'asc', label: '↑', hint: 'По возрастанию' }]} />
        </div>
      </SettingRow>
      <SettingRow title="Группы"><Select value={s.group} onChange={(group) => set({ group: group as DraftsSettings['group'] })} options={GROUPS} className="!h-7 !w-36" aria-label="Группы" /></SettingRow>
      <SettingRow title="Черновики"><Seg label="Чьи черновики" value={s.scope} onChange={(scope) => set({ scope })} options={[{ value: 'all', label: 'Всех проектов' }, { value: 'current', label: 'Текущего' }]} /></SettingRow>
      <SettingRow title="Папки-черновики"><Switch label="Папки-черновики" checked={s.folders} onChange={(folders) => set({ folders })} /></SettingRow>

      <Title>Кнопка и открытие</Title>
      <SettingRow title="Счётчик на кнопке"><Seg label="Счётчик на кнопке" value={s.badge} onChange={(badge) => set({ badge })} options={[{ value: 'all', label: 'Все' }, { value: 'unsent', label: 'Не в проекте' }, { value: 'off', label: 'Нет' }]} /></SettingRow>
      <SettingRow title="Открывать"><Seg label="Открывать" value={s.openOn} onChange={(openOn) => set({ openOn })} options={[{ value: 'click', label: 'Щелчком' }, { value: 'hover', label: 'Наведением' }]} /></SettingRow>
      <SettingRow title="Закрывать щелчком вне панели"><Switch label="Закрывать щелчком вне панели" checked={s.closeOutside} onChange={(closeOutside) => set({ closeOutside })} /></SettingRow>

      <Title>Действия</Title>
      <SettingRow title="Перетаскивание на папку публикует" desc="Всегда с подтверждением"><Switch label="Перетаскивание на папку публикует" checked={s.dropPublish} onChange={(dropPublish) => set({ dropPublish })} /></SettingRow>
      <SettingRow title="Напоминать о старых"><Seg label="Напоминание о старых" value={String(s.remindDays)} onChange={(v) => set({ remindDays: Number(v) as DraftsSettings['remindDays'] })} options={[{ value: '7', label: '7 дн.' }, { value: '14', label: '14 дн.' }, { value: '30', label: '30 дн.' }, { value: '0', label: 'Никогда' }]} /></SettingRow>
    </div>
    <footer className="flex h-9 shrink-0 items-center justify-end border-t border-[var(--flux-line)] px-2">
      <button type="button" className="fx-btn fx-btn-sm fx-btn-quiet" onClick={s.reset}>Сбросить</button>
    </footer>
  </section>;
}
