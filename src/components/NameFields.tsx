import React, { useEffect, useMemo } from 'react';
import { Cake, User2, Wand2 } from 'lucide-react';
import {
  declineFullName, initials, guessGender, fullNameOf, Gender,
} from '../lib/declension';

/**
 * Поля ФИО сотрудника: фамилия, имя и отчество вводятся по отдельности и
 * только в именительном падеже — остальные формы программа образует сама.
 * Пол подставляется по отчеству: в девяти случаях из десяти он однозначен,
 * и лишний выбор человеку не нужен, но поправить его можно.
 *
 * Под полями показан живой пример: как имя встанет в подпись и в «от кого».
 * Так сразу видно, если правило не справилось с редкой фамилией.
 */

export interface NameValue {
  lastName: string;
  firstName: string;
  middleName: string;
  gender: string;      // 'M' | 'F' | ''
  birthDate: string;   // YYYY-MM-DD для input[type=date]
}

export const EMPTY_NAME: NameValue = { lastName: '', firstName: '', middleName: '', gender: '', birthDate: '' };

// Вид полей — общий (fx-input, fx-label), как у всех форм программы
const inputCls = 'fx-input';
const labelCls = 'fx-label block mb-1';

export default function NameFields({
  value, onChange, disabled, compact,
}: {
  value: NameValue;
  onChange: (next: NameValue) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const set = (patch: Partial<NameValue>) => onChange({ ...value, ...patch });

  // Пол по отчеству — пока человек не выбрал его сам
  const guessed = useMemo(() => guessGender(value.middleName), [value.middleName]);
  useEffect(() => {
    if (!value.gender && guessed) set({ gender: guessed });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guessed]);

  const gender: Gender = value.gender === 'F' ? 'F' : 'M';
  const parts = { lastName: value.lastName, firstName: value.firstName, middleName: value.middleName };
  const filled = !!(value.lastName || value.firstName);

  return (
    <div className="space-y-3">
      <div className={compact ? 'grid grid-cols-1 gap-3' : 'grid grid-cols-1 sm:grid-cols-3 gap-3'}>
        <div>
          <label className={labelCls}>Фамилия</label>
          <input type="text" required value={value.lastName} disabled={disabled}
            onChange={(e) => set({ lastName: e.target.value })}
            className={inputCls} placeholder="Раупов" autoComplete="off" />
        </div>
        <div>
          <label className={labelCls}>Имя</label>
          <input type="text" required value={value.firstName} disabled={disabled}
            onChange={(e) => set({ firstName: e.target.value })}
            className={inputCls} placeholder="Хусрав" autoComplete="off" />
        </div>
        <div>
          <label className={labelCls}>Отчество</label>
          <input type="text" value={value.middleName} disabled={disabled}
            onChange={(e) => set({ middleName: e.target.value })}
            className={inputCls} placeholder="Хусравович" autoComplete="off" />
        </div>
      </div>

      <div className={compact ? 'grid grid-cols-1 gap-3' : 'grid grid-cols-1 sm:grid-cols-2 gap-3'}>
        <div>
          <label className={labelCls}>Пол</label>
          <div className="fx-segctl" role="group" aria-label="Пол">
            {([['M', 'Мужской'], ['F', 'Женский']] as const).map(([id, label]) => (
              <button key={id} type="button" disabled={disabled} aria-pressed={value.gender === id} onClick={() => set({ gender: id })}>
                {label}
              </button>
            ))}
          </div>
          {guessed && value.gender === guessed && (
            <p className="fx-hint mt-1 flex items-center gap-1">
              <Wand2 className="w-3 h-3" /> определён по отчеству — можно поправить
            </p>
          )}
        </div>
        <div>
          <label className={labelCls}>Дата рождения</label>
          <input type="date" value={value.birthDate} disabled={disabled}
            onChange={(e) => set({ birthDate: e.target.value })}
            className={inputCls} />
          <p className="fx-hint mt-1 flex items-center gap-1">
            <Cake className="w-3 h-3" /> в этот день главный экран поздравит сотрудника
          </p>
        </div>
      </div>

      {filled && (
        <div className="pt-1">
          <div className="fx-label mb-1 flex items-center gap-1">
            <User2 className="w-3 h-3" /> как программа применит это имя
          </div>
          {/* Одна колонка: формы ФИО длинные, а обрезанное многоточием имя
              не даёт проверить, правильно ли программа его склонила. */}
          <dl className="space-y-0.5 text-xs">
            <div className="flex gap-1.5"><dt className="text-slate-400 shrink-0 w-[5.5rem]">в подписи:</dt>
              <dd className="text-slate-800 dark:text-slate-100">{initials(parts)}</dd></div>
            <div className="flex gap-1.5"><dt className="text-slate-400 shrink-0 w-[5.5rem]">полностью:</dt>
              <dd className="text-slate-600 dark:text-slate-300">{fullNameOf(parts)}</dd></div>
            <div className="flex gap-1.5"><dt className="text-slate-400 shrink-0 w-[5.5rem]">от кого:</dt>
              <dd className="text-slate-600 dark:text-slate-300">{declineFullName(parts, gender, 'gen')}</dd></div>
            <div className="flex gap-1.5"><dt className="text-slate-400 shrink-0 w-[5.5rem]">кому:</dt>
              <dd className="text-slate-600 dark:text-slate-300">{declineFullName(parts, gender, 'dat')}</dd></div>
          </dl>
        </div>
      )}
    </div>
  );
}
