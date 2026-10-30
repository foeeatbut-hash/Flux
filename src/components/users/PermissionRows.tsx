import { Btn, Input, Status, Switch } from '../ui';
import { FEATURES, ADMIN_FEATURES, OPEN_BY_DEFAULT, entryOf, type PermMap } from '../../lib/permissions';
import type { AccessLevel } from '../../../shared/positions';

/** Дата и время для input[type=datetime-local] */
const toDateTimeInput = (value: any): string => {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

interface Props {
  level: AccessLevel;
  isOwner: boolean;
  /** Личные права сотрудника (поверх должностей) */
  perms: PermMap;
  setPerms: (update: (prev: PermMap) => PermMap) => void;
  /** Что уже дают должности: основная целиком и включённое у дополнительных */
  positionPerms: PermMap;
  disabled?: boolean;
}

/**
 * Права доступа в карточке сотрудника.
 * Сотруднику — рабочие функции строками с переключателем; администратору
 * рабочие функции доступны все, а его полномочия (admin.*) выдаёт только
 * владелец, поэтому блок полномочий виден и меняется только при уровне
 * «Администратор» и только владельцем.
 */
export default function PermissionRows({ level, isOwner, perms, setPerms, positionPerms, disabled }: Props) {
  const toggle = (feature: string, enabled: boolean) =>
    setPerms((prev) => ({ ...prev, [feature]: { enabled, until: prev[feature]?.until ?? null } }));
  const setUntil = (feature: string, value: string) =>
    setPerms((prev) => ({ ...prev, [feature]: { enabled: prev[feature]?.enabled ?? true, until: value ? new Date(value).toISOString() : null } }));

  if (level === 'ADMIN') {
    return (
      <div>
        <div className="fx-label mt-2 mb-1">Права доступа</div>
        <Status tone="slate">Рабочие функции доступны администратору</Status>
        <p className="fx-hint mt-2">Административные полномочия назначает владелец лично. Должность не даёт права выдавать обновления или менять подключение к базе.</p>
        {isOwner && ADMIN_FEATURES.map((feature) => {
          const entry = perms[feature.id];
          return <div key={feature.id} className="fx-set-row items-start">
            <div className="fx-set-text">{feature.label}<div className="fx-set-desc">{feature.desc}</div>
              {entry?.enabled && <label className="flex flex-wrap items-center gap-2 mt-2 text-xs text-slate-500 dark:text-slate-400">Действует до<Input type="datetime-local" value={toDateTimeInput(entry.until)} onChange={(event) => setUntil(feature.id, event.target.value)} disabled={disabled} className="w-auto" /><span>{entry.until ? '' : 'Бессрочно'}</span></label>}
            </div>
            <Switch checked={!!entry?.enabled} onChange={(value) => toggle(feature.id, value)} label={feature.label} disabled={disabled} />
          </div>;
        })}
      </div>
    );
  }

  return (
    <div>
      <div className="fx-label mt-2 mb-1">Права доступа</div>
      {FEATURES.map((f) => {
        const e = perms[f.id];
        // Право, открытое по умолчанию, переключатель показывает таким,
        // каким оно действует (должности, умолчание, личное); снятие пишет запрет
        const open = OPEN_BY_DEFAULT.includes(f.id);
        const on = open ? !!entryOf({ ...positionPerms, ...perms }, f.id)?.enabled : !!e?.enabled;
        const isExpired = !!e?.until && new Date(e.until).getTime() < Date.now();
        // Что уже дают должности: иначе админ выдаёт лично то, что у человека
        // и так есть, и потом не понимает, почему снятие галочки ничего не изменило
        const fromPosition = !!positionPerms[f.id]?.enabled;
        return (
          <div key={f.id} className="fx-set-row items-start">
            <div className="fx-set-text">
              <span className="inline-flex items-center gap-2 flex-wrap">
                {f.label}
                <span className="text-xs text-slate-400">{f.group}</span>
                {fromPosition && !on && <Status tone="sky">уже даёт должность</Status>}
                {f.risky && <Status tone="amber">осторожно</Status>}
                {open && e && !e.enabled && <Status tone="rose">запрещено лично</Status>}
                {on && isExpired && <Status tone="rose">истекло</Status>}
              </span>
              <div className="fx-set-desc">
                {f.desc}
                {open && !e && on && ' У всех по умолчанию — выключите, чтобы запретить.'}
              </div>
              {on && (
                <span className="flex items-center gap-2 flex-wrap mt-1.5 text-xs text-slate-500 dark:text-slate-400">
                  действует до
                  <Input type="datetime-local" value={toDateTimeInput(e?.until)} onChange={(ev) => setUntil(f.id, ev.target.value)} disabled={disabled} className="w-auto" />
                  {e?.until
                    ? <Btn size="sm" tone="ghost" onClick={() => setUntil(f.id, '')}>бессрочно</Btn>
                    : <span>бессрочно</span>}
                </span>
              )}
            </div>
            <Switch checked={on} onChange={(v) => toggle(f.id, v)} label={f.label} disabled={disabled} />
          </div>
        );
      })}
      <p className="fx-hint mt-1.5">Административные полномочия назначает только владелец Flux.</p>
    </div>
  );
}
