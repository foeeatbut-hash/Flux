import RoleIcon from '../RoleIcon';
import { Field, Select, Seg } from '../ui';
import type { Role } from '../../lib/roles';
import type { AccessLevel } from '../../../shared/positions';

/**
 * Должности и уровень доступа в карточке и в регистрации сотрудника.
 *
 * Три разных вопроса, и они не смешиваются: кем человек работает (основная
 * должность — обязательна), что он делает сверх этого (дополнительные — только
 * расширяют права) и администратор ли он (уровень: его видит и меняет только
 * владелец). Администратор — не должность, поэтому в списках должностей его нет.
 */
export interface PositionFieldsValue {
  primary: string;
  extras: string[];
  level: AccessLevel;
}

interface Props {
  /** Должности справочника без уровней доступа */
  positions: Role[];
  value: PositionFieldsValue;
  onChange: (next: PositionFieldsValue) => void;
  /** Уровень видит и меняет только владелец */
  canSetLevel: boolean;
  disabled?: boolean;
}

export default function PositionFields({ positions, value, onChange, canSetLevel, disabled }: Props) {
  const known = positions.some((p) => p.code === value.primary);
  const options = [
    ...(value.primary ? [] : [{ value: '', label: 'Выберите должность', disabled: true }]),
    // Должности нет в справочнике (запись старше справочника): показываем как есть, не подменяя первой из списка
    ...(value.primary && !known ? [{ value: value.primary, label: `${value.primary} (нет в справочнике)` }] : []),
    ...positions.map((p) => ({ value: p.code, label: p.name })),
  ];
  // Основная исключена из дополнительных: должность не бывает и той и другой
  const extraChoices = positions.filter((p) => p.code !== value.primary);
  const toggle = (code: string) => onChange({
    ...value,
    extras: value.extras.includes(code) ? value.extras.filter((c) => c !== code) : [...value.extras, code],
  });

  return (
    <>
      <Field label="Основная должность" hint="Кем сотрудник работает. Обязательна; её права действуют целиком.">
        <Select value={value.primary} disabled={disabled} aria-label="Основная должность" options={options}
          onChange={(primary) => onChange({ ...value, primary, extras: value.extras.filter((c) => c !== primary) })} />
      </Field>
      <div className="fx-field">
        <span className="fx-label" id="extra-positions-label">Дополнительные должности</span>
        {extraChoices.length === 0
          ? <span className="fx-hint">Других должностей в справочнике нет.</span>
          : <div className="fx-seg" role="group" aria-labelledby="extra-positions-label">
            {extraChoices.map((p) => (
              <button key={p.code} type="button" disabled={disabled} aria-pressed={value.extras.includes(p.code)} onClick={() => toggle(p.code)} title={p.description || p.name}>
                <RoleIcon name={p.icon} className="w-3.5 h-3.5 shrink-0" />{p.name}
              </button>
            ))}
          </div>}
        <span className="fx-hint">Только добавляют права. Запреты основной должности они не снимают.</span>
      </div>
      {canSetLevel && (
        // Не Field: подпись-label нажала бы первую кнопку переключателя
        <div className="fx-field">
          <span className="fx-label">Уровень доступа</span>
          <Seg label="Уровень доступа" value={value.level === 'ADMIN' ? 'ADMIN' : 'EMPLOYEE'}
            onChange={(level) => onChange({ ...value, level })}
            options={[{ value: 'EMPLOYEE', label: 'Сотрудник' }, { value: 'ADMIN', label: 'Администратор' }]} />
          <span className="fx-hint">Администраторов назначает только владелец. Полномочия администратора выдаются ниже.</span>
        </div>
      )}
    </>
  );
}
