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
  const tone = mode === 'ALLOW'
    ? 'border-emerald-300 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/20'
    : mode === 'DENY'
      ? 'border-rose-200 dark:border-rose-900/50 bg-rose-50/50 dark:bg-rose-950/20'
      : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950';

  return (
    <div className={`rounded-lg border p-2.5 transition-colors ${tone}`}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-slate-800 dark:text-white">{def.label}</span>
            {def.risky && <span className="text-2xs font-bold text-amber-600 dark:text-amber-400">осторожно</span>}
            <span className="text-2xs text-slate-400 dark:text-slate-500">{roleSays(fromRole)}</span>
          </div>
          <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5 leading-relaxed">{def.desc}</p>
        </div>

        <div className="flex items-center gap-1 shrink-0" role="group" aria-label={`Доступ: ${def.label}`}>
          {CHOICES.map((c) => (
            <button
              key={c.id}
              type="button"
              disabled={disabled}
              title={c.hint}
              aria-pressed={mode === c.id}
              onClick={() => onPick(c.id)}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-2xs font-bold cursor-pointer
                          transition-colors disabled:opacity-50 disabled:cursor-default ${
                mode === c.id
                  ? c.id === 'DENY'
                    ? 'bg-rose-600 text-white'
                    : c.id === 'ALLOW'
                      ? 'bg-emerald-600 text-white'
                      : 'bg-slate-600 text-white'
                  : 'bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-850'
              }`}
            >
              <c.icon className="w-3 h-3" />
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {mode !== 'INHERIT' && (
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <span className="text-xs text-slate-500 dark:text-slate-400">действует до:</span>
          <input
            type="datetime-local"
            value={entry?.until ? new Date(entry.until).toISOString().slice(0, 16) : ''}
            onChange={(e) => onUntil(e.target.value)}
            disabled={disabled}
            className="px-2 py-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded
                       text-xs text-slate-800 dark:text-white focus:outline-none focus:border-emerald-500"
          />
          {entry?.until
            ? <button type="button" onClick={() => onUntil('')} className="text-xs text-emerald-700 dark:text-emerald-400 hover:underline cursor-pointer">бессрочно</button>
            : <span className="text-xs text-slate-400 dark:text-slate-500">бессрочно; после срока отвечает роль</span>}
        </div>
      )}
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
      <label className="block text-xs font-semibold text-slate-550 dark:text-slate-400 uppercase tracking-widest mb-2">
        Встроенные программы
      </label>
      {platformOn === false && (
        <div className="mb-2 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 p-2.5 text-xs text-amber-700 dark:text-amber-300 leading-relaxed">
          Flux Play сейчас выключен для всей компании — выданный доступ заработает, когда его включат.
          {onOpenSettings && (
            <button type="button" onClick={onOpenSettings}
              className="ml-1.5 font-bold underline underline-offset-2 cursor-pointer">
              Включить в Настройках
            </button>
          )}
        </div>
      )}
      <p className="text-xs text-slate-400 dark:text-slate-500 mb-2 leading-relaxed">
        Роль администратора сама по себе не открывает игры. Выдайте доступ явно в карточке или через роль.
        Пока не выдан доступ к платформе, сотрудник не видит её нигде.
        <button type="button" disabled={disabled} onClick={allGames}
          className="ml-1.5 font-bold text-emerald-700 dark:text-emerald-400 hover:underline cursor-pointer disabled:opacity-50">
          Выдать доступ ко всем играм
        </button>
      </p>
      <div className="space-y-3">
        {PLAY_GROUPS.map((group) => {
          const items = PLAY_ENTITLEMENTS.filter((e) => e.group === group);
          if (!items.length) return null;
          return (
            <section key={group}>
              <h4 className="text-2xs font-bold uppercase tracking-wide text-slate-400 dark:text-slate-500 mb-1">{group}</h4>
              <div className="space-y-1.5">
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
