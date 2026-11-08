import React from 'react';
import { Input, Select } from '../ui';
import { catalogService } from '../../services/catalogService';
import { dataService } from '../../services/dataService';
import { useAppContext } from '../../store/policyStore';
import { can } from '../../lib/permissions';
import EquipmentClassActions from '../docflow/EquipmentClassActions';

/** Ручной класс проходит тот же план, что заполнение проекта: автоназначения здесь нет. */
export default function TagCatalogClass({ tag, projectId, onChanged }: { tag: any; projectId: string; onChanged: () => void }) {
  const { user } = useAppContext();
  const allowed = can(user, 'equipment.manage');
  const [equipment, setEquipment] = React.useState(tag.equipment);
  const [classId, setClassId] = React.useState(tag.equipment?.catalogClassId || '');
  const [type, setType] = React.useState(tag.equipment?.type || '');
  const [classes, setClasses] = React.useState<Array<{ value: string; label: string }>>([]);
  const [error, setError] = React.useState('');
  React.useEffect(() => {
    let alive = true;
    void catalogService.catalog().then(catalog => {
      if (alive) setClasses(catalog.classes.map(c => ({ value: c.id, label: `${c.code} — ${c.title?.ru || c.code}` })));
    }).catch(() => { if (alive) setError('Не удалось прочитать Каталог'); });
    return () => { alive = false; };
  }, []);
  const refresh = async () => {
    try {
      const answer = await dataService.getTags(projectId);
      const current = (answer.tags || []).find((t: any) => t.id === tag.id);
      if (current) { setEquipment(current.equipment); setClassId(current.equipment?.catalogClassId || ''); setType(current.equipment?.type || ''); }
      onChanged();
    } catch { setError('Класс сохранён, но карточку не удалось перечитать. Откройте её заново.'); }
  };
  return <section className="space-y-2" aria-label="Класс оборудования тега">
    <h4 className="fx-label">Класс Каталога</h4>
    <p className="fx-note">Класс определяет комплект документов тега. Сейчас: {classes.find(c => c.value === equipment?.catalogClassId)?.label || equipment?.catalogClassId || 'не задан'}.</p>
    <label className="fx-field"><span className="fx-label">Тип оборудования</span><Input aria-label="Тип оборудования тега" value={type} onChange={e => setType(e.target.value)} disabled={!allowed} /></label>
    <label className="fx-field"><span className="fx-label">Класс Каталога</span><Select aria-label="Класс Каталога тега" value={classId} options={[{ value: '', label: '—' }, ...classes]} onChange={setClassId} disabled={!allowed} /></label>
    {error && <p role="alert" className="fx-note">{error}</p>}
    {allowed && <EquipmentClassActions projectId={projectId} tagIds={[tag.id]} overrides={classId ? [{ tagId: tag.id, classId, type }] : undefined}
      disabled={!type || !classId || !!error} label="Предпросмотр класса…" onApplied={() => void refresh()} />}
  </section>;
}
