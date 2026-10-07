import React from 'react';
import { count } from '../../lib/plural';

/**
 * Предупреждение «позиции уже в схеме КИП» (docs/e3-integration.md, 9.4).
 *
 * Позиция в схеме — чужая работа: переподбор у ОВ её меняет, а КИП об этом не
 * знает. Это не запрет, а строка над деревом: ввоз пройдёт, но человек видит,
 * сколько позиций заденет, и после записи тому, кто выгружал, уйдёт одно
 * уведомление. Список по установкам — по раскрытию.
 */
export default function InSchemeNotice({ inScheme }: { inScheme: { count: number; bySystem: Record<string, number> } }) {
  const systems = Object.entries(inScheme.bySystem || {});
  const one = systems.length === 1 ? systems[0][0] : '';
  return (
    <div role="status" className="px-5 py-2 border-b border-slate-200 dark:border-slate-800 text-xs shrink-0">
      <div className="fx-st fx-st-warn text-slate-800 dark:text-slate-100">
        <span>
          {one ? `${count(inScheme.count, 'позиция', 'позиции', 'позиций')} установки «${one}» уже в схеме КИП` : `${count(inScheme.count, 'позиция', 'позиции', 'позиций')} уже в схеме КИП`}
        </span>
      </div>
      <div className="mt-0.5 pl-3 text-slate-500 dark:text-slate-400">
        Импорт не запрещён: после записи тому, кто выгружал схему, придёт уведомление, а в E3Flux позиции отметятся как изменившиеся.
      </div>
      {systems.length > 1 && (
        <details className="mt-1 pl-3">
          <summary className="cursor-pointer text-slate-500 dark:text-slate-400">По установкам · {systems.length}</summary>
          <ul className="mt-1 space-y-0.5">
            {systems.map(([name, n]) => (
              <li key={name} className="flex gap-2"><span className="min-w-0 truncate" title={name}>{name}</span><span className="tabular-nums text-slate-500 dark:text-slate-400">{n}</span></li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
