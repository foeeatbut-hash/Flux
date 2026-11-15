/**
 * Отказ записи с перечнем «Поле: было → стало» — общий для всех программ.
 *
 * Запись изменил коллега, пока человек её правил: текст отказа (его присылает
 * сервер готовым) и под ним — что именно изменилось. В форме стоит на месте
 * прежней строки отказа; у действий без формы (удаление, отвязка тега)
 * показывается окном. Для массовых действий — перечень по записям (`groups`).
 *
 * Сам перечень собирает `lib/recordChanges`; здесь только показ. `role="alert"`:
 * отказ читают с экранного диктора сразу, как только он появился.
 */
import type { FieldChange } from '../../lib/recordChanges';

export interface ConflictGroup {
  /** Название записи: «Вентилятор А» */
  title: string;
  changes: FieldChange[];
}

/** Когда различий в показанных полях нет, а версия выросла: тот же текст, что у сервера (словарь отказов) */
export const NO_SHOWN_CHANGES = 'Изменения не затронули то, что показано на экране.';

function ChangeList({ changes }: { changes: FieldChange[] }) {
  return (
    <ul className="fx-conflict-list" data-conflict-changes>
      {changes.map((c, i) => (
        <li key={`${c.label}-${i}`} data-conflict-change>
          <span className="fx-conflict-field">{c.label}:</span>
          <span className="fx-conflict-was">{c.was}</span>
          <span className="fx-conflict-arrow" aria-hidden="true">→</span>
          <span className="sr-only">стало</span>
          <span className="fx-conflict-now">{c.now}</span>
        </li>
      ))}
    </ul>
  );
}

export default function ConflictNotice({ message, changes, groups, emptyText = NO_SHOWN_CHANGES, className = '' }: {
  /** Текст отказа */
  message: string;
  /** Перечень по одной записи; `undefined` — перечня нет вовсе (запись удалена, открыта у коллеги), `[]` — различий в показанном нет */
  changes?: FieldChange[];
  /** Перечень по записям — для массовых действий; записи без различий пропускаются */
  groups?: ConflictGroup[];
  emptyText?: string;
  className?: string;
}) {
  const shownGroups = (groups || []).filter((g) => g.changes.length > 0);
  return (
    <div role="alert" data-conflict-notice className={`fx-conflict ${className}`.trim()}>
      <p className="fx-conflict-message" data-conflict-message>{message}</p>
      {changes && changes.length > 0 && <ChangeList changes={changes} />}
      {changes && changes.length === 0 && <p className="fx-hint m-0" data-conflict-empty>{emptyText}</p>}
      {groups && shownGroups.length === 0 && <p className="fx-hint m-0" data-conflict-empty>{emptyText}</p>}
      {shownGroups.map((g, i) => (
        <section key={`${g.title}-${i}`} data-conflict-group className="flex flex-col gap-1">
          <h4 className="fx-conflict-group">{g.title}</h4>
          <ChangeList changes={g.changes} />
        </section>
      ))}
    </div>
  );
}
