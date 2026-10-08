/**
 * Справочник атрибутов E3 «По типам»: слева типы Flux, справа атрибуты типа с «Да»
 * и откуда Flux берёт значение именно для этого типа.
 *
 * Решение владельца (docs/e3-integration.md, этап B): источник значения задаётся
 * один раз для типа оборудования и действует для всех его позиций во всех
 * проектах; если для типа не задан — общий источник атрибута. Читать могут все,
 * править — по правам справочника; правка идёт через ту же одиночную запись
 * атрибута, что и в списке, поэтому устаревшая версия ничего не затирает.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { attributesForClass, sourceFor, type E3Attribute } from '../../../e3/attributes';
import { CLASSES, classTitle } from '../../../equipment/classes';
import type { E3ItemPatch } from '../../services/e3AttributesService';
import { Chip, Empty } from './ui';
import E3ClassSourceDialog from './E3ClassSourceDialog';
import { sourceText } from './e3AttributeText';

const muted = 'text-slate-500 dark:text-slate-400';
const cell = 'truncate max-w-[260px]';

/** «Да» у атрибута типа: именно их значение должен дать Flux */
const fluxAttrs = (items: E3Attribute[], cls: string) => attributesForClass(items, cls).filter((a) => a.fromFlux);

export default function E3AttributesByClass({ items, canEdit, busy, error, onSave, onDialogClose, focus }: {
  items: E3Attribute[]; canEdit: boolean; busy: boolean; error: string;
  onSave: (name: string, patch: E3ItemPatch) => Promise<boolean>; onDialogClose: () => void;
  /** Переход из «Нет данных»: тип и атрибут, который надо открыть; принятый переход панель гасит */
  focus?: { cls?: string; id?: string; accept: () => void } | null;
}) {
  const [cls, setCls] = useState('ДВИГАТЕЛЬ');
  const [editing, setEditing] = useState('');
  useEffect(() => {
    if (!focus) return;
    if (focus.cls) setCls(focus.cls);
    if (focus.id) setEditing(focus.id);
    focus.accept();
    // accept гасит переход у владельца; зависим только от самого перехода
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.cls, focus?.id]);

  // «Задано» — у атрибута для типа есть итоговый источник, «нужно задать» — его нет
  const stats = useMemo(() => CLASSES.map((c) => {
    const list = fluxAttrs(items, c.id);
    const todo = list.filter((a) => sourceFor(a, c.id).kind === 'none').length;
    return { id: c.id, title: c.title, done: list.length - todo, todo };
  }), [items]);
  const rows = useMemo(() => fluxAttrs(items, cls), [items, cls]);
  const attr = items.find((a) => a.name === editing && !a.removed);
  const close = () => { setEditing(''); onDialogClose(); };

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="fx-side flex w-60 shrink-0 flex-col overflow-auto" aria-label="Типы оборудования">
        <h4 className="fx-gh"><span className="min-w-0 flex-1">Тип Flux</span><span title="задано / нужно задать">задано / нужно</span></h4>
        {stats.map((s) => (
          <div key={s.id} className="fx-li" role="button" tabIndex={0} aria-current={cls === s.id} onClick={() => setCls(s.id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCls(s.id); } }}>
            <span className="min-w-0 flex-1 truncate">{s.title}</span>
            <span className="fx-n" title={`Задано ${s.done}, нужно задать ${s.todo}`}>{s.done} / {s.todo > 0 ? <b className="text-amber-600 dark:text-amber-400">{s.todo}</b> : s.todo}</span>
          </div>
        ))}
      </aside>
      <div className="fx-page-body min-w-0 flex-1" aria-label={`Атрибуты типа «${classTitle(cls)}»`}>
        {!rows.length ? <div className="p-4"><Empty title={`У типа «${classTitle(cls)}» нет атрибутов с «Да»`} text="Значения заполняет Flux у атрибутов с «Да» в справочнике; типы атрибута задаются в его карточке." /></div> : (
          <table className="fx-table text-left">
            <thead><tr><th>Атрибут E3</th><th>Описание</th><th>Откуда для этого типа</th><th>Общий источник</th></tr></thead>
            <tbody>{rows.map((a) => {
              const own = a.sourceByClass?.[cls];
              const eff = sourceFor(a, cls);
              return (
                <tr key={a.name} tabIndex={0} role="button" className="cursor-pointer" onClick={() => setEditing(a.name)}
                  onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setEditing(a.name); } }}>
                  <td className={`${cell} font-mono`} title={a.name}>{a.name}</td>
                  <td className={cell} title={a.title}>{a.title || '—'}</td>
                  <td className={cell}>
                    {eff.kind === 'none' ? <Chip tone="amber" title="Источника нет — значение вводит инженер КИП">не задан</Chip>
                      : own ? <span title="Задан для этого типа">{sourceText(own)}</span>
                        : <span className={muted} title="Как у атрибута (общий источник)">{sourceText(eff)}</span>}
                  </td>
                  <td className={`${cell} ${muted}`}>{sourceText(a.source) || '—'}</td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </div>
      {attr && <E3ClassSourceDialog key={`${attr.name}:${cls}`} attr={attr} cls={cls} canEdit={canEdit} busy={busy} error={error}
        onSave={async (patch) => { if (await onSave(attr.name, patch)) close(); }} onClose={close} />}
    </div>
  );
}
