import React from 'react';
import { Btn, Input } from '../ui';
import { catalogService } from '../../services/catalogService';
import type { EquipmentClass } from '../../../catalog/model';
import { classMappingErrors, type EquipmentClassMapping } from '../../../shared/docflow/classMapping';

/** Настройка действует только в текущем проекте; строки сохраняются вместе с настройками ДО. */
export default function EquipmentClassesEditor({ rows, disabled, onChange }: {
  rows: EquipmentClassMapping[]; disabled: boolean; onChange: (rows: EquipmentClassMapping[]) => void;
}) {
  const [classes, setClasses] = React.useState<EquipmentClass[]>([]);
  const [error, setError] = React.useState('');
  React.useEffect(() => {
    let alive = true;
    void catalogService.catalog().then((data) => { if (alive) setClasses(data.classes || []); })
      .catch(() => { if (alive) setError('Не удалось загрузить классы каталога. Повторно откройте раздел.'); });
    return () => { alive = false; };
  }, []);
  const errors = classMappingErrors(rows);
  const update = (index: number, patch: Partial<EquipmentClassMapping>) => onChange(rows.map((row, i) => i === index ? { ...row, ...patch } : row));
  return <section aria-label="Классы оборудования" className="space-y-3">
    <p className="text-xs text-slate-500 dark:text-slate-400">Соответствия действуют только в этом проекте. Они используются, когда у оборудования не выбран свой класс каталога.</p>
    {error && <p role="alert" className="text-xs text-rose-700 dark:text-rose-400">{error}</p>}
    {rows.map((row, index) => <div key={index} className="flex flex-wrap items-end gap-2">
      <label className="block text-xs flex-1 min-w-32">Тип оборудования<Input aria-label={`Тип оборудования ${index + 1}`} value={row.type} disabled={disabled} onChange={(e) => update(index, { type: e.target.value })} /></label>
      <label className="block text-xs flex-1 min-w-48">Класс каталога<select className="fx-input w-full" aria-label={`Класс каталога ${index + 1}`} value={row.classId} disabled={disabled || !!error} onChange={(e) => update(index, { classId: e.target.value })}>
        <option value="">Выберите класс</option>
        {row.classId && !classes.some((item) => item.id === row.classId) && <option value={row.classId}>Недоступный класс: {row.classId}</option>}
        {classes.map((item) => <option key={item.id} value={item.id}>{item.title?.ru || item.code}</option>)}
      </select></label>
      {!disabled && <Btn tone="ghost" aria-label={`Удалить соответствие ${index + 1}`} onClick={() => onChange(rows.filter((_, i) => i !== index))}>Удалить</Btn>}
    </div>)}
    {!disabled && <Btn onClick={() => onChange([...rows, { type: '', classId: '' }])} disabled={rows.length >= 500}>Добавить соответствие</Btn>}
    {errors.length > 0 && <div role="alert" className="text-xs text-rose-700 dark:text-rose-400">{errors.map((message, i) => <p key={i}>{message}</p>)}</div>}
  </section>;
}
