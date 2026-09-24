/**
 * Доступ к встроенным программам в карточке сотрудника.
 *
 * Отдельным блоком, а не галочками рядом с рабочими правами, по трём причинам,
 * и каждая видна прямо на экране:
 *
 *   1. **Состояний три, а не два.** У рабочего права их два: выдано или нет.
 *      Здесь есть ещё «не сказано» — тогда отвечают права роли. Поэтому
 *      переключатель из трёх положений, а не галочка: галочка не умеет
 *      отличить «запрещено этому человеку» от «про него ничего не сказано»,
 *      а разница между ними и есть весь смысл.
 *   2. **Роль администратора ничего не даёт.** Рабочие права администратору
 *      не показывают вовсе — он и так может всё. Здесь показывают: доступ к
 *      платформе выдаётся явно, и себе тоже.
 *   3. **Блока не видно тому, у кого самого нет доступа.** Список игр — это
 *      список игр, и пустые строки в чужой карточке рассказали бы о платформе
 *      ровно столько же, сколько заполненные.
 */
import React from 'react';
import { Ban, Check, Minus } from 'lucide-react';
import { PLAY_ENTITLEMENTS, PLAY_GROUPS, PLAY_PLAYER_ENTITLEMENTS, type PlayEntitlementDef } from '../../../play/features';
import { entryMode } from '../../lib/appPolicy';
import { Btn, Input, Status } from '../ui';
import type { PermEntry, PermMap } from '../../lib/permissions';

export type Mode = 'INHERIT' | 'ALLOW' | 'DENY';

const CHOICES: Array<{ id: Mode; label: string; hint: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'INHERIT', label: 'По роли', hint: 'Ничего не сказано: ответят права роли', icon: Minus },
  { id: 'ALLOW', label: 'Выдать', hint: 'Доступ есть, даже если роль его не даёт', icon: Check },
  { id: 'DENY', label: 'Запретить', hint: 'Доступа нет, даже если роль его даёт', icon: Ban },
];

/** Как выглядит ответ роли — чтобы «По роли» не читалось как «неизвестно». */
function roleSays(entry: PermEntry | undefined): string {
  const m = entryMode(entry);
  if (m === 'ALLOW') return 'роль даёт';
  if (m === 'DENY') return 'роль запрещает';
  return 'роль не даёт';
}

function Row({ def, entry, fromRole, disabled, onPick, onUntil }: {
  def: PlayEntitlementDef;
  entry: PermEntry | undefined;
  fromRole: PermEntry | undefined;
  disabled?: boolean;
  onPick: (mode: Mode) => void;
  onUntil: (value: string) => void;
}) {
  const mode = entryMode(entry);
  return (
    <div className="fx-set-row items-start">
      <div className="fx-set-text">
        <span className="inline-flex items-center gap-2 flex-wrap">
          {def.label}
          {def.risky && <Status tone="amber">осторожно</Status>}
          <span className="text-xs text-slate-400">{roleSays(fromRole)}</span>
        </span>
        <div className="fx-set-desc">{def.desc}</div>
        {mode !== 'INHERIT' && (
          <span className="flex items-center gap-2 flex-wrap mt-1.5 text-xs text-slate-500 dark:text-slate-400">
            действует до
            <Input type="datetime-local" value={entry?.until ? new Date(entry.until).toISOString().slice(0, 16) : ''}
              onChange={(e) => onUntil(e.target.value)} disabled={disabled} className="w-auto" />
            {entry?.until
              ? <Btn size="sm" tone="ghost" onClick={() => onUntil('')}>бессрочно</Btn>
              : <span>бессрочно; после срока отвечает роль</span>}
          </span>
        )}
      </div>
      {/* Три положения — переключатель вариантов, а не цветные кнопки: какое
          выбрано, видно по подложке, смысл «запрет» несёт значок и слово */}
      <div className="fx-segctl shrink-0" role="group" aria-label={`Доступ: ${def.label}`}>
        {CHOICES.map((c) => (
          <button key={c.id} type="button" disabled={disabled} title={c.hint} aria-pressed={mode === c.id} onClick={() => onPick(c.id)}>
            <c.icon className="w-3 h-3" />{c.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function PlayAccess({ perms, rolePerms, disabled, onSet, platformOn, onOpenSettings }: {
  perms: PermMap;
  rolePerms: PermMap;
  disabled?: boolean;
  /** mode = null — стереть запись, то есть вернуть «ничего не сказано» */
  onSet: (key: string, mode: Mode, until: string | null) => void;
  /** Включена ли платформа в компании: выключенная не видна никому, даже с доступом */
  platformOn?: boolean;
  /** Открыть лист «Flux Play» в Настройках — там её включают */
  onOpenSettings?: () => void;
}) {
  // Вместе с играми нужны вход в раздел и действия для группы и матча.
  const allGames = () => { for (const entry of PLAY_PLAYER_ENTITLEMENTS) onSet(entry.id, 'ALLOW', null); };
  return (
    <div>
      <div className="fx-label mt-2 mb-1">Встроенные программы</div>
      {platformOn === false && (
        <p className="text-xs text-amber-700 dark:text-amber-300 mb-1.5">
          Flux Play сейчас выключен для всей компании — выданный доступ заработает, когда его включат.
          {onOpenSettings && <Btn size="sm" tone="ghost" onClick={onOpenSettings} className="ml-1">Включить в Настройках</Btn>}
        </p>
      )}
      <p className="fx-hint mb-1">
        Роль администратора сама не открывает игры: доступ выдаётся явно, здесь или через роль.
        <Btn size="sm" tone="ghost" disabled={disabled} onClick={allGames} className="ml-1">Выдать доступ ко всем играм</Btn>
      </p>
      <div>
        {PLAY_GROUPS.map((group) => {
          const items = PLAY_ENTITLEMENTS.filter((e) => e.group === group);
          if (!items.length) return null;
          return (
            <section key={group}>
              <h4 className="fx-gh px-0">{group}</h4>
              <div>
                {items.map((def) => (
                  <Row
                    key={def.id}
                    def={def}
                    entry={perms[def.id]}
                    fromRole={rolePerms[def.id]}
                    disabled={disabled}
                    onPick={(mode) => onSet(def.id, mode, perms[def.id]?.until ?? null)}
                    onUntil={(v) => onSet(def.id, entryMode(perms[def.id]) as Mode, v ? new Date(v).toISOString() : null)}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
