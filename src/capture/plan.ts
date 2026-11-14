import { CaptureRow, Shape, normCode, mixedScript, fitsShape } from './recognize';

/**
 * План захвата: что случится с каждым кодом, если нажать «Применить».
 *
 * Ни одной записи в базу до подтверждения — тот же принцип, что у импорта
 * бланков. И ещё одно правило, своё: план захвата НИКОГДА не содержит
 * удалений. Захват — фрагмент, а не документ; из того, что кода нет в
 * выделении, не следует, что его нет в проекте.
 */

export type ConflictClass =
  | 'new'
  | 'exactSame'
  | 'exactFill'
  | 'exactDiff'
  | 'caseAlike'
  | 'layoutAlike'
  | 'fuzzyAlike'
  | 'offShape';

export type Action = 'create' | 'skip' | 'fill' | 'replace' | 'duplicate' | 'link';

export const ACTION_LABEL: Record<Action, string> = {
  create: 'Создать',
  skip: 'Пропустить',
  fill: 'Дополнить только пустые',
  replace: 'Заменить из захвата',
  duplicate: 'Создать дубль',
  link: 'Привязать к существующему',
};

export const CLASS_LABEL: Record<ConflictClass, string> = {
  new: 'новый',
  exactSame: 'дубль, ничего нового',
  exactFill: 'дубль, есть новое',
  exactDiff: 'дубль, поля расходятся',
  caseAlike: 'похож: регистр и дефисы',
  layoutAlike: 'похож: раскладка',
  fuzzyAlike: 'похож по написанию',
  offShape: 'не похож на теги проекта',
};

/** Цвет класса в интерфейсе: зелёный — безопасно, красный — спросить */
export const CLASS_TONE: Record<ConflictClass, 'ok' | 'warn' | 'bad' | 'mute'> = {
  new: 'ok',
  exactSame: 'mute',
  exactFill: 'warn',
  exactDiff: 'bad',
  caseAlike: 'warn',
  layoutAlike: 'bad',
  fuzzyAlike: 'warn',
  offShape: 'mute',
};

// «Создать дубль» не предлагается: второй тег с тем же кодом в проекте не даёт завести
// база (ключ кода, server/tagCodeKey.ts). Действие осталось в типе для старых сборок —
// сервер отвечает на него пропуском с причиной.
const OPTIONS: Record<ConflictClass, Action[]> = {
  new: ['create', 'skip'],
  exactSame: ['skip'],
  exactFill: ['fill', 'skip', 'replace'],
  exactDiff: ['skip', 'fill', 'replace'],
  caseAlike: ['link', 'create', 'skip'],
  layoutAlike: ['link', 'create', 'skip'],
  fuzzyAlike: ['link', 'create', 'skip'],
  offShape: ['skip', 'create'],
};

const DEFAULT_ACTION: Record<ConflictClass, Action> = {
  new: 'create',
  exactSame: 'skip',
  exactFill: 'fill',
  // Расхождение полей не решается за инженера: по умолчанию не трогаем чужое
  exactDiff: 'skip',
  caseAlike: 'link',
  layoutAlike: 'link',
  fuzzyAlike: 'link',
  offShape: 'skip',
};

export interface ExistingTag {
  id: string;
  identifier: string;
  brand?: string | null;
  department?: string | null;
  fluid?: string | null;
  wbs?: string | null;
  metadata?: string | null;
}

export interface PlanRow {
  key: string;
  identifier: string;
  cls: ConflictClass;
  action: Action;
  options: Action[];
  why: string;
  /** Отмечена ли строка к применению */
  on: boolean;
  existing?: ExistingTag;
  /** Поля, которые захват может добавить или изменить */
  fills: string[];
  diffs: { field: string; mine: string; theirs: string }[];
  row: CaptureRow;
}

const FIELD_LABELS: Record<string, string> = {
  brand: 'марка', department: 'отдел', fluid: 'среда', wbs: 'WBS',
};
const COMPARED = ['brand', 'department', 'fluid', 'wbs'] as const;

/**
 * Расстояние с перестановкой (Дамерау—Левенштейн, вариант OSA),
 * нормализованное на длину. Перестановка считается за одну правку, а не за
 * две: «FNA-07» вместо «FAN-07» — это один промах пальцами, и обычное
 * расстояние Левенштейна оценивает такую опечатку вдвое строже, чем следует.
 */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const d: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) d[i][0] = i;
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return 1 - d[a.length][b.length] / Math.max(a.length, b.length);
}

/** Цифры кода подряд: «P-101A» → «101» */
const digitsOf = (s: string) => (s.match(/\d+/g) || []).join('');

/**
 * Похожесть по написанию — только когда цифры совпадают, а разошлись буквы.
 *
 * Это не придирка. «AHU-21» и «AHU-211» отличаются на один знак, но это два
 * разных аппарата, и предложить привязать один к другому — прямой путь
 * потерять позицию. Опечатка бывает в буквенной части; номер инженер набирает
 * осознанно. Поэтому разные цифры закрывают вопрос сразу.
 */
function typoLike(a: string, b: string): number {
  if (digitsOf(a) !== digitsOf(b)) return 0;
  return similarity(a, b);
}

export function buildPlan(rows: CaptureRow[], existing: ExistingTag[], shape: Shape): PlanRow[] {
  const byExact = new Map<string, ExistingTag>();
  const byNorm = new Map<string, ExistingTag>();
  for (const t of existing) {
    const code = (t.identifier || '').trim();
    if (!code) continue;
    if (!byExact.has(code)) byExact.set(code, t);
    const n = normCode(code);
    if (!byNorm.has(n)) byNorm.set(n, t);
  }

  return rows.map((row) => {
    const code = row.identifier.trim();
    const exact = byExact.get(code);
    const norm = byNorm.get(normCode(code));

    let cls: ConflictClass;
    let why = '';
    const fills: string[] = [];
    const diffs: { field: string; mine: string; theirs: string }[] = [];

    if (exact) {
      for (const f of COMPARED) {
        const mine = String((exact as any)[f] || '').trim();
        const theirs = String((row as any)[f] || '').trim();
        if (!theirs) continue;
        if (!mine) fills.push(f);
        else if (mine !== theirs) diffs.push({ field: f, mine, theirs });
      }
      if (diffs.length) {
        cls = 'exactDiff';
        const d = diffs[0];
        why = `${FIELD_LABELS[d.field] || d.field}: «${d.mine}» ← → «${d.theirs}»`;
      } else if (fills.length) {
        cls = 'exactFill';
        why = `у существующего пусто: ${fills.map((f) => FIELD_LABELS[f] || f).join(', ')}`;
      } else {
        cls = 'exactSame';
        why = 'такой тег уже есть, нового в захвате нет';
      }
    } else if (norm) {
      if (mixedScript(code) || mixedScript(norm.identifier)) {
        cls = 'layoutAlike';
        why = `в проекте «${norm.identifier}» — в коде смешаны латиница и кириллица`;
      } else {
        cls = 'caseAlike';
        why = `в проекте записан как «${norm.identifier}»`;
      }
    } else {
      // Ближайший по написанию среди существующих
      let bestTag: ExistingTag | undefined;
      let bestScore = 0;
      const n = normCode(code);
      for (const t of existing) {
        const s = typoLike(n, normCode(t.identifier || ''));
        if (s > bestScore) { bestScore = s; bestTag = t; }
      }
      if (bestTag && bestScore >= 0.75) {
        cls = 'fuzzyAlike';
        why = `похож на «${bestTag.identifier}» (${Math.round(bestScore * 100)}%)`;
        return finish(row, code, cls, bestTag, fills, diffs, why);
      }
      if (row.verdict === 'doubt' || !fitsShape(code, shape)) {
        cls = 'offShape';
        why = shape.fromCount
          ? `не подошёл под образец кодов проекта (снят с ${shape.fromCount})`
          : 'в проекте ещё нет тегов — сравнить не с чем';
      } else {
        cls = 'new';
        why = 'кода нет в проекте';
      }
    }
    return finish(row, code, cls, exact || norm, fills, diffs, why);
  });
}

function finish(
  row: CaptureRow, code: string, cls: ConflictClass,
  existing: ExistingTag | undefined,
  fills: string[], diffs: { field: string; mine: string; theirs: string }[], why: string,
): PlanRow {
  const action = DEFAULT_ACTION[cls];
  return {
    key: row.key,
    identifier: code,
    cls,
    action,
    options: OPTIONS[cls],
    why,
    // Сомнительные и «ничего нового» приходят со снятой галочкой:
    // молча в базу они не попадут
    on: cls !== 'offShape' && cls !== 'exactSame',
    existing,
    fills,
    diffs,
    row,
  };
}

export interface PlanSummary {
  create: number;
  fill: number;
  replace: number;
  duplicate: number;
  link: number;
  skip: number;
}

export function summarize(plan: PlanRow[]): PlanSummary {
  const s: PlanSummary = { create: 0, fill: 0, replace: 0, duplicate: 0, link: 0, skip: 0 };
  for (const r of plan) {
    if (!r.on) { s.skip++; continue; }
    s[r.action] = (s[r.action] || 0) + 1;
  }
  return s;
}
