/**
 * Какая установка проекта принимает установку из файла (Д4 и Д5 из
 * docs/e3-integration.md, 1.2 и 1.6).
 *
 * Раньше установка находилась по имени и всё: переименованная («П1» → «П1.1»)
 * заводилась второй, а две одноимённые из разных файлов сливались в одну.
 * Теперь по имени ищутся ВСЕ подходящие, и если однозначно выбрать нельзя —
 * в план идёт строка с вопросом. Чистая логика: состав установок в базе
 * приходит снаружи, запись и план зовут одну и ту же функцию.
 */
import { matchSystems } from './specUtils.js';

export interface SysLite { id: string; name: string; fileName?: string | null }

export interface SystemRow {
  /** `unit‖имя‖файл` — по нему решение приходит в запись */
  key: string;
  /** rename — «это она?»; pick — одинаковые имена, нужно выбрать */
  kind: 'rename' | 'pick';
  name: string;
  why: string;
  options: { value: string; label: string }[];
  default: string;
  choice: string;
}

export interface SystemResolution {
  system: SysLite | null;
  /** renamed: прежняя установка получает имя из файла, ID остаётся */
  how: 'exact' | 'similar' | 'renamed' | 'none';
  row?: SystemRow;
}

export const systemRowKey = (name: string, fileName: string) => `unit‖${name}‖${fileName}`;

/** Доля общих адресов; пустая сторона ничего не доказывает, и сходство считается полным */
function overlap(a: Set<string>, b: Set<string>): { share: number; common: number } {
  if (!a.size || !b.size) return { share: 1, common: 0 };
  let common = 0;
  for (const x of a) if (b.has(x)) common++;
  return { share: common / (a.size + b.size - common), common };
}

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

/** «П1» и «П1.1», «У-2» и «У-2А»: одно имя продолжает другое или отличается парой знаков */
const related = (a: string, b: string): boolean => {
  const x = squash(a), y = squash(b);
  return !!x && !!y && (x.includes(y) || y.includes(x) || distance(x, y) <= 2);
};

export interface ResolveArgs {
  existing: SysLite[];
  /** Установки, уже занятые другой установкой этого же ввоза */
  claimed: Set<string>;
  unit: { name: string; fileName: string; addresses: Set<string> };
  /** Имена всех установок файла: переименованной считается та, чьего имени в файле нет */
  fileUnitNames: string[];
  /** Адреса позиций установки в базе (моноблок‖код, без служебного блока) */
  compositionOf: (systemId: string) => Promise<Set<string>>;
  choices?: Record<string, string>;
}

export async function resolveSystem(a: ResolveArgs): Promise<SystemResolution> {
  const { unit } = a;
  const key = systemRowKey(unit.name, unit.fileName);
  const asked = a.choices?.[key];
  const open = a.existing.filter(s => !a.claimed.has(s.id));
  const { hits, how } = matchSystems(open, unit.name);

  if (hits.length === 0) {
    // Д4: имени в расчёте нет, но есть установка того же состава — это она же, переименованная
    const named = (s: SysLite) => a.fileUnitNames.some(n => matchSystems([s], n).how !== 'none');
    const cands: { s: SysLite; share: number }[] = [];
    for (const s of open) {
      if (named(s)) continue;
      const sameFile = !!s.fileName && s.fileName === unit.fileName;
      if (!sameFile && !related(s.name, unit.name)) continue;
      const { share, common } = overlap(unit.addresses, await a.compositionOf(s.id));
      if (common >= 1 && share >= 0.8) cands.push({ s, share });
    }
    cands.sort((x, y) => y.share - x.share);
    if (!cands.length || (cands[1] && cands[1].share === cands[0].share)) return { system: null, how: 'none' };
    const s = cands[0].s;
    const choice = asked === 'new' ? 'new' : 'rename';
    return {
      system: choice === 'rename' ? s : null,
      how: choice === 'rename' ? 'renamed' : 'none',
      row: {
        key, kind: 'rename', name: unit.name,
        why: `В расчёте нет «${s.name}», появилась «${unit.name}» с тем же составом — это она?`,
        options: [{ value: 'rename', label: 'Да, это она' }, { value: 'new', label: 'Нет, новая установка' }],
        default: 'rename', choice,
      },
    };
  }

  const answer = (system: SysLite): SystemResolution => ({ system, how: how === 'exact' ? 'exact' : 'similar' });
  const label = (s: SysLite) => `«${s.name}»${s.fileName ? `, файл ${s.fileName}` : ''}`;

  // Одна подходящая: сливаем, пока это не явно другая установка с тем же именем
  // (другой файл И другой состав — одинаково названные установки двух расчётов)
  if (hits.length === 1) {
    const s = hits[0];
    const otherFile = !!s.fileName && !!unit.fileName && s.fileName !== unit.fileName;
    if (!otherFile) return answer(s);
    const { share } = overlap(unit.addresses, await a.compositionOf(s.id));
    if (share >= 0.5) return answer(s);
    const choice = asked === s.id ? s.id : 'new';
    return {
      ...(choice === 'new' ? { system: null, how: 'none' as const } : answer(s)),
      row: {
        key, kind: 'pick', name: unit.name,
        why: `Установка «${unit.name}» уже есть, но из другого файла (${s.fileName}) и с другим составом — та же или новая?`,
        options: [{ value: s.id, label: `Та же: ${label(s)}` }, { value: 'new', label: 'Новая установка' }],
        default: 'new', choice,
      },
    };
  }

  // Несколько одноимённых (Д5): по имени файла, затем по составу; не вышло — спрашиваем
  const byFile = unit.fileName ? hits.filter(s => s.fileName === unit.fileName) : [];
  if (byFile.length === 1) return answer(byFile[0]);
  const scored: { s: SysLite; share: number }[] = [];
  for (const s of hits) scored.push({ s, share: overlap(unit.addresses, await a.compositionOf(s.id)).share });
  scored.sort((x, y) => y.share - x.share);
  if (scored[0].share >= 0.5 && scored[0].share > scored[1].share) return answer(scored[0].s);

  const chosen = hits.find(s => s.id === asked);
  return {
    ...(chosen ? answer(chosen) : { system: null, how: 'none' as const }),
    row: {
      key, kind: 'pick', name: unit.name,
      why: `Установок с именем «${unit.name}» в категории несколько — сопоставить с файлом нельзя, выберите`,
      options: [...hits.map(s => ({ value: s.id, label: label(s) })), { value: 'new', label: 'Новая установка' }],
      default: 'new', choice: chosen ? chosen.id : 'new',
    },
  };
}
