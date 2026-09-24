import React from 'react';
import type { ProjectInput } from '../services/dataService';

/**
 * Поля карточки проекта — один набор на создание и на правку.
 *
 * Зачем отдельным компонентом. Раньше форм было две и они расходились: при
 * создании спрашивали код, заказчика и подрядчика, а при правке этих полей не
 * было вовсе — то есть заполнить их можно было ровно один раз и уже никогда не
 * исправить. Заодно одно и то же поле называлось по-разному: `description` был
 * «Примечанием» в одной форме и «Кратким описанием» в другой.
 *
 * Теперь набор один, порядок один, названия одни. Появится новое поле проекта —
 * оно появится в обеих формах, потому что форма одна.
 */

export type ProjectDraft = Required<Pick<ProjectInput, 'name' | 'code' | 'customer' | 'contractor' | 'description' | 'info' | 'status'>>;

export const emptyProject = (): ProjectDraft => ({
  name: '', code: '', customer: '', contractor: '', description: '', info: '', status: 'ACTIVE',
});

/** Черновик из того, что пришло с сервера: пустые поля не должны стать undefined */
export const draftOf = (p: Partial<ProjectInput> | null | undefined): ProjectDraft => ({
  name: p?.name || '',
  code: p?.code || '',
  customer: p?.customer || '',
  contractor: p?.contractor || '',
  description: p?.description || '',
  info: p?.info || '',
  status: p?.status || 'ACTIVE',
});

/** Что уходит на сервер: пробелы по краям срезаны */
export const trimmed = (d: ProjectDraft): ProjectDraft => ({
  name: d.name.trim(),
  code: d.code.trim(),
  customer: d.customer.trim(),
  contractor: d.contractor.trim(),
  description: d.description.trim(),
  info: d.info.trim(),
  status: d.status,
});

const FIELD = 'fx-input w-full min-w-0';
const LABEL = 'fx-label block mb-1';

interface Props {
  value: ProjectDraft;
  onChange: (next: ProjectDraft) => void;
  disabled?: boolean;
  /** Статус спрашиваем только при правке: новый проект всегда в работе */
  showStatus?: boolean;
}

export default function ProjectFields({ value, onChange, disabled, showStatus }: Props) {
  const set = (k: keyof ProjectDraft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    onChange({ ...value, [k]: e.target.value });

  return (
    <div className="space-y-3.5">
      <div>
        <label className={LABEL}>Наименование</label>
        <input type="text" value={value.name} onChange={set('name')} disabled={disabled}
               className={FIELD} placeholder="Название проекта" />
      </div>

      {/* Код и заказчик — то, по чему проект узнают в переписке и документах */}
      <div className="grid grid-cols-1 @[520px]:grid-cols-2 gap-3">
        <div>
          <label className={LABEL}>Код проекта</label>
          <input type="text" value={value.code} onChange={set('code')} disabled={disabled}
                 className={FIELD} placeholder="—" />
        </div>
        <div>
          <label className={LABEL}>Заказчик</label>
          <input type="text" value={value.customer} onChange={set('customer')} disabled={disabled}
                 className={FIELD} placeholder="—" />
        </div>
      </div>

      <div>
        <label className={LABEL}>Подрядчик</label>
        <input type="text" value={value.contractor} onChange={set('contractor')} disabled={disabled}
               className={FIELD} placeholder="—" />
      </div>

      <div>
        <label className={LABEL}>Краткое описание</label>
        <input type="text" value={value.description} onChange={set('description')} disabled={disabled}
               className={FIELD} placeholder="Одной строкой — она видна в списке проектов" />
      </div>

      <div>
        <label className={LABEL}>Подробное описание</label>
        <textarea value={value.info} onChange={set('info')} disabled={disabled} rows={5}
                  className={`${FIELD} resize-y`}
                  placeholder="Спецификация, адрес площадки, ведущие инженеры — всё, что нужно знать про проект" />
      </div>

      {showStatus && (
        <div>
          <label className={LABEL}>Статус проекта</label>
          <select value={value.status} onChange={set('status')} disabled={disabled}
                  className={`${FIELD} cursor-pointer`}>
            <option value="ACTIVE">В работе</option>
            <option value="ARCHIVED">Архив</option>
          </select>
        </div>
      )}
    </div>
  );
}
