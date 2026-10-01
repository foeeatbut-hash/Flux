/**
 * Карточка тега: окно правки одного тега (код, наименование, марка, WBS,
 * дополнительные поля из справочника, комментарии, документы ВДР).
 *
 * Вынесена из Registry.tsx как есть. Состояние формы (`modalCode`,
 * `modalMainName`, `editTagBrand`, `savedFlash`) здесь намеренно не живёт:
 * его пишет ещё сам Registry — `handleRenameTag` возвращает прежний код и
 * зажигает «Сохранено», а эффект открытия карточки заполняет поля при смене
 * id. Заведи оно здесь свою копию, обработчики Registry разошлись бы с полями.
 * Окно монтируется, только пока карточка открыта, — как и раньше.
 */
import React from 'react';
import { Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import CustomSelect from '../CustomSelect';
import { Btn, Status, Dialog } from '../ui';
import { useToastStore } from '../../store/toastStore';
import TagComments from './TagComments';
import TagVdrDocs from './TagVdrDocs';
import { useTagNavigationStore } from '../../store/tagNavigationStore';
import { openInProject } from '../../lib/projectScope';
import {
  parseTagMetadata, getTagOverallStatus, statusConfig, actualitySelectOptions, type DescriptionItem,
} from './tagMeta';

/** Одинаковое поле карточки тега: раньше каждое несло свой набор классов */
const cardField = 'w-full px-2.5 py-1.5 bg-slate-50 dark:bg-slate-900 border border-slate-205 dark:border-slate-800 rounded-lg text-xs text-slate-850 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500';

export interface TagCardModalProps {
  /** Открытый тег — окно монтируют только при непустом значении */
  tag: any;
  setEditingTag: React.Dispatch<React.SetStateAction<any | null>>;
  /** Перечитать теги: после закрытия карточки список должен показать правки */
  loadTags: () => void | Promise<void>;
  modalCode: string;
  setModalCode: (code: string) => void;
  onRenameTag: (tagId: string, rawCode: string) => Promise<void>;
  savedFlash: boolean;
  flashSaved: () => void;
  onDeleteTag: (tagId: string) => Promise<void>;
  modalMainName: string;
  setModalMainName: (name: string) => void;
  onUpdateMainName: (tagId: string, name: string) => Promise<void>;
  editTagBrand: string;
  setEditTagBrand: (brand: string) => void;
  onUpdateBrand: (tagId: string, value: string) => Promise<void>;
  projectBrands: string[];
  setTags: React.Dispatch<React.SetStateAction<any[]>>;
  /** Справочники проекта: из «__tag_creation_config__» берутся дополнительные поля */
  dictionaries: any[];
  onUpdateDynamicFields: (tagId: string, updatedFields: Record<string, string>) => Promise<void>;
  onAddDescription: (tagId: string, text: string, comment: string, status?: DescriptionItem['status']) => Promise<void>;
  onUpdateDescription: (tagId: string, descId: string, fields: Partial<DescriptionItem>) => Promise<void>;
  onRemoveDescription: (tagId: string, descId: string) => Promise<void>;
  formatDate: (iso?: string) => string;
  projectId: string;
}

export default function TagCardModal({
  tag, setEditingTag, loadTags, modalCode, setModalCode, onRenameTag, savedFlash, flashSaved,
  onDeleteTag, modalMainName, setModalMainName, onUpdateMainName, editTagBrand, setEditTagBrand,
  onUpdateBrand, projectBrands, setTags, dictionaries, onUpdateDynamicFields, onAddDescription,
  onUpdateDescription, onRemoveDescription, formatDate, projectId,
}: TagCardModalProps) {
  const { addToast } = useToastStore();
  const navigate = useNavigate();
  return (
    <Dialog
      label={`Тег ${tag.identifier}`}
      width="max-w-lg"
      onClose={() => { setEditingTag(null); loadTags(); }}
      title={
        <span className="flex items-center gap-2 min-w-0">
          <input
                      value={modalCode}
                      onChange={(e) => setModalCode(e.target.value)}
                      onBlur={() => onRenameTag(tag.id, modalCode)}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                      spellCheck={false}
                      aria-label="Код тега"
                      className="fx-input min-w-0 flex-1 font-mono"
                      title="Код тега можно изменить прямо здесь — связи сохранятся"
                    />
          <span className={`fx-note shrink-0 transition-opacity duration-300 ${savedFlash ? 'opacity-100' : 'opacity-0'}`}>Сохранено</span>
        </span>
      }
      footer={<>
        <button type="button"
          onClick={async () => { const id = tag.id; setEditingTag(null); await onDeleteTag(id); }}
          className="fx-btn fx-btn-danger mr-auto"
          title="Удалить тег со всеми связями"
        >
          <Trash2 className="w-3.5 h-3.5" /> Удалить тег
        </button>
        <span className="fx-note">Изменения сохраняются сами</span>
        <Btn tone="primary" onClick={() => { setEditingTag(null); loadTags(); }}>Готово</Btn>
      </>}
    >
          {/* Плотнее, чем было: карточку открывают ради одной правки, а
              она требовала прокрутки из-за крупных блоков с отступами */}
          <div className="space-y-3 text-left">

            {/* Наименование и актуальность — то, ради чего карточку открыли */}
            <div className="space-y-1 text-left">
              <div className="flex items-baseline justify-between gap-2">
                <label className="fx-label">Наименование</label>
                {/* Актуальность тега не задаётся отдельно: она складывается
                    из комментариев ниже. Показываем её тем же значком, что
                    и в списке, — иначе человек ищет переключатель, которого
                    нет, и решает, что поле пропало */}
                {(() => {
                  const look = statusConfig[getTagOverallStatus(tag)] || statusConfig.draft;
                  return (
                    <Status tone={look.tone} title="Актуальность тега складывается из его комментариев">{look.label}</Status>
                  );
                })()}
              </div>
              <input
                type="text"
                placeholder="Напр., Приточная вентиляционная установка"
                value={modalMainName}
                onChange={(e) => setModalMainName(e.target.value)}
                onBlur={async () => {
                  if (modalMainName !== (parseTagMetadata(tag).mainName || '')) {
                    await onUpdateMainName(tag.id, modalMainName);
                    flashSaved();
                  }
                }}
                className={cardField}
              />
            </div>

            <button type="button" className="fx-btn fx-btn-quiet" onClick={() => {
              const positions = Array.isArray(tag.componentElements) ? tag.componentElements : [];
              if (positions.length === 1) {
                const position = positions[0];
                openInProject({
                  what: `Оборудование для тега ${tag.identifier}`,
                  projectId,
                  open: () => { setEditingTag(null); navigate(`/equipment?component=${encodeURIComponent(position.id)}`); },
                });
              } else {
                setEditingTag(null);
                useTagNavigationStore.getState().open({ projectId, tagId: tag.id, identifier: tag.identifier });
              }
            }}>
              Характеристики оборудования
            </button>

            {/* Марка и WBS. Конструктор марки убран: он собирал строку из
                трёх списков справочника, которого почти нигде нет, и занимал
                треть карточки, показывая пустоту. Марка сейчас — просто
                марка, а подсказка берётся из марок этого же проекта */}
            <div className="grid grid-cols-1 @[560px]:grid-cols-2 gap-2.5">
              <div className="space-y-1 text-left">
                <label className="fx-label block">Марка</label>
                <input
                  type="text"
                  list="tag-brands"
                  placeholder="Напр. Датчик-К1"
                  value={editTagBrand}
                  onChange={(e) => setEditTagBrand(e.target.value)}
                  onBlur={async () => {
                    if (editTagBrand !== (tag.brand || '')) {
                      await onUpdateBrand(tag.id, editTagBrand);
                      flashSaved();
                    }
                  }}
                  className={cardField}
                />
                <datalist id="tag-brands">
                  {projectBrands.map((b) => <option key={b} value={b} />)}
                </datalist>
              </div>
              <div className="space-y-1 text-left">
                <label className="fx-label block">WBS</label>
                <input
                  key={`wbs-${tag.id}`}
                  type="text"
                  placeholder="Структура работ, необязательно"
                  defaultValue={tag.wbs || ''}
                  onBlur={async (e) => {
                    const v = e.target.value.trim();
                    if (v === (tag.wbs || '')) return;
                    try {
                      const res = await fetch(`/api/tags/${tag.id}`, {
                        method: 'PUT', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ wbs: v }),
                      });
                      if (!res.ok) throw new Error();
                      setTags(prev => prev.map(t => t.id === tag.id ? { ...t, wbs: v } : t));
                      setEditingTag((prev: any) => prev ? { ...prev, wbs: v } : null);
                      flashSaved();
                    } catch { addToast('Не удалось сохранить WBS', 'error'); }
                  }}
                  className={cardField}
                />
              </div>
            </div>

            {/* Дополнительные поля — те, что заведены в «Справочнике».
                Заведённое там появляется здесь само: это и есть обещанная
                расширяемость, а не отдельная настройка карточки */}
            {(() => {
              const configDict = dictionaries.find(d => d.name === '__tag_creation_config__');
              const cats = configDict
                ? (configDict.items || [])
                    .filter((i: any) => !i.parentId)
                    .sort((a: any, b: any) => a.code.localeCompare(b.code))
                : [];

              if (cats.length > 0) {
                const tagMeta = parseTagMetadata(tag);
                const tagDFields = tagMeta.dynamicFields || {};

                return (
                  <div className="space-y-2">
                    <label className="fx-label block">Дополнительные поля</label>
                    <div className="grid grid-cols-1 @[560px]:grid-cols-2 gap-2.5">
                      {cats.map((cat: any) => {
                        const options = (configDict?.items || [])
                          .filter((i: any) => i.parentId === cat.id)
                          .sort((a: any, b: any) => a.nameRu.localeCompare(b.nameRu));

                        return (
                          <div key={cat.id} className="space-y-1">
                            <span className="fx-label">{cat.nameRu}</span>
                            <CustomSelect
                              value={tagDFields[cat.nameRu] || ''}
                              onChange={(val) => { onUpdateDynamicFields(tag.id, { [cat.nameRu]: val }); flashSaved(); }}
                              placeholder="-- Выберите --"
                              options={options.map((opt: any) => ({
                                value: opt.nameRu,
                                label: opt.nameRu
                              }))}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              }
              return null;
            })()}

            <TagComments
              items={parseTagMetadata(tag).descriptions as any}
              statusConfig={statusConfig as any}
              statusOptions={actualitySelectOptions}
              formatDate={formatDate}
              onAdd={async (text, comment, status) => {
                await onAddDescription(tag.id, text, comment, status as any);
                flashSaved();
              }}
              onUpdate={async (id, patch) => {
                await onUpdateDescription(tag.id, id, patch as any);
                flashSaved();
              }}
              onRemove={(id) => onRemoveDescription(tag.id, id)}
            />

            {/* Документы ВДР по этому тегу (главный тег строки реестра) */}
            <TagVdrDocs identifier={tag.identifier} projectId={projectId} />

          </div>

    </Dialog>
  );
}
