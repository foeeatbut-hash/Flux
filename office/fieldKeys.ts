/**
 * Поля данных проекта в файлах Flux Office: как ключ поля записан в файле.
 *
 * Один договор на троих — окно (панель «Данные проекта»), сервер
 * (server/officeFields.ts, «Обновить поля» закрытого файла) и проверки. Если
 * окно и сервер записывали бы ключ по-разному, поле, вставленное в окне,
 * сервер бы не узнал — и тихо оставил в документе старое значение.
 *
 * Ключ поля — строка вида:
 *   project.code            — поле проекта (name, code, customer, contractor, description, status);
 *   doc.name                — имя файла; doc.code / doc.revision / doc.title — из строки ВДР этого файла;
 *   tag[AHU-1].brand        — поле тега; путь — тот же, что у Конструктора (resolveValue):
 *   tag[AHU-1].param:Группа|Ключ, el[П1].name, el[П1].param:Группа|Ключ;
 *   vdr[<шифр>].revision    — строка ВДР по шифру;
 *   sign.prepared.name      — «Разработал» (checked — «Проверил», approved — «Утвердил»), .date — дата;
 *   today, year.
 *
 * Где ключ живёт в файле (разведка — docs/office-project-data.md):
 *   - Документ: поле Word DOCPROPERTY "flux:<ключ>", видимый текст — его
 *     результат. Закладки и элементы управления GenOffice при правке абзаца
 *     теряет, а поле переживает и правку, и сохранение;
 *   - Таблица: определённое имя FLUX_<ключ в безопасной записи> на ячейку.
 *     Движок Таблицы хранит имена и пишет их обратно, в том числе новые.
 */

/** Роли подписей: «Разработал», «Проверил», «Утвердил» */
export const SIGN_ROLES = ['prepared', 'checked', 'approved'] as const;
export type SignRole = typeof SIGN_ROLES[number];
export const SIGN_TITLES: Record<SignRole, string> = { prepared: 'Разработал', checked: 'Проверил', approved: 'Утвердил' };

export const PROJECT_FIELDS = ['name', 'code', 'customer', 'contractor', 'description', 'status'] as const;

export type FieldRef =
  | { kind: 'project'; path: string }
  | { kind: 'doc'; path: string }
  | { kind: 'tag' | 'el' | 'vdr'; id: string; path: string }
  | { kind: 'sign'; role: SignRole; path: 'name' | 'date' }
  | { kind: 'today' | 'year' };

/**
 * Годен ли ключ для записи в файл. Кавычка и обратная черта ломают
 * инструкцию поля Word, перевод строки — имя в книге; длина — предел Excel
 * на имя (255) с запасом на кодирование
 */
export function keyAllowed(key: string): boolean {
  return !!key && key.length <= 200 && !/["\\\r\n\u0000-\u001f]/.test(key) && parseKey(key) !== null;
}

/** Разобрать ключ; незнакомый — null (такое поле программа не трогает) */
export function parseKey(key: string): FieldRef | null {
  const k = String(key || '');
  if (k === 'today' || k === 'year') return { kind: k };
  let m = /^project\.([a-z]+)$/.exec(k);
  if (m) return (PROJECT_FIELDS as readonly string[]).includes(m[1]) ? { kind: 'project', path: m[1] } : null;
  m = /^doc\.([a-z]+)$/.exec(k);
  if (m) return { kind: 'doc', path: m[1] };
  m = /^sign\.([a-z]+)\.(name|date)$/.exec(k);
  if (m) return (SIGN_ROLES as readonly string[]).includes(m[1]) ? { kind: 'sign', role: m[1] as SignRole, path: m[2] as 'name' | 'date' } : null;
  // Код сущности — в квадратных скобках: в кодах бывают точки (TT-1.2), и
  // без скобок нельзя было бы понять, где кончается код и начинается путь
  m = /^(tag|el|vdr)\[([^\]]+)\]\.(.+)$/.exec(k);
  if (m) return { kind: m[1] as 'tag' | 'el' | 'vdr', id: m[2], path: m[3] };
  return null;
}

export const makeKey = (kind: 'tag' | 'el' | 'vdr', id: string, path: string): string => `${kind}[${id}].${path}`;

// ── Документ: поле Word ──

const INSTR_RE = /^\s*DOCPROPERTY\s+"flux:([^"]+)"\s*$/;

/** Инструкция поля Word для ключа */
export const docInstr = (key: string): string => `DOCPROPERTY "flux:${key}"`;

/** Ключ из инструкции поля; чужое поле — null */
export function keyOfInstr(instr: string): string | null {
  const m = INSTR_RE.exec(String(instr || ''));
  return m ? m[1] : null;
}

// ── Таблица: определённое имя ──

export const NAME_PREFIX = 'FLUX_';
export const BLOCK_RE = /^FLUX_BLOCK_(\d+)$/;

/**
 * Безопасная запись ключа для имени Excel. В имени можно буквы (любые, и
 * кириллицу), цифры, точку и подчёркивание; остальное — «_XX» (код знака),
 * а само подчёркивание — «_5F». Запись обратима: «_» в ней всегда начало кода,
 * поэтому «__» свободно и отмечает второе вхождение того же ключа
 */
export function encodeKeyName(key: string): string {
  let out = '';
  for (const ch of key) {
    if (/^[\p{L}0-9.]$/u.test(ch)) { out += ch; continue; }
    const code = ch.codePointAt(0)!;
    if (code < 0x100) out += '_' + code.toString(16).toUpperCase().padStart(2, '0');
    else for (const unit of ch.split('')) out += '_u' + unit.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

export function decodeKeyName(enc: string): string | null {
  let out = '';
  for (let i = 0; i < enc.length;) {
    if (enc[i] !== '_') { out += enc[i++]; continue; }
    if (enc[i + 1] === 'u') {
      const hex = enc.slice(i + 2, i + 6);
      if (!/^[0-9A-F]{4}$/.test(hex)) return null;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 6;
    } else {
      const hex = enc.slice(i + 1, i + 3);
      if (!/^[0-9A-F]{2}$/.test(hex)) return null;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 3;
    }
  }
  return out;
}

/** Имя ячейки поля: FLUX_<ключ>, второе вхождение того же ключа — FLUX_<ключ>__2 */
export function sheetName(key: string, n = 1): string {
  return NAME_PREFIX + encodeKeyName(key) + (n > 1 ? `__${n}` : '');
}

/** Ключ из имени книги; не поле Flux (или блок) — null */
export function keyOfSheetName(name: string): string | null {
  if (!name.startsWith(NAME_PREFIX) || BLOCK_RE.test(name)) return null;
  const key = decodeKeyName(name.slice(NAME_PREFIX.length).replace(/__\d+$/, ''));
  return key && parseKey(key) ? key : null;
}

/** Предел Excel на длину имени */
export const NAME_MAX = 255;

/** Число из строки поля — числом: иначе в Таблице не сложится СУММ() */
export function cellValue(v: string | number): string | number {
  if (typeof v === 'number') return v;
  const s = String(v ?? '');
  const t = s.replace(/[\s ]/g, '').replace(',', '.');
  // Ведущий ноль — код, а не число: «007» не должно стать 7
  if (!/^-?(0|[1-9]\d*)(\.\d+)?$/.test(t) || t.length > 15) return s;
  return Number(t);
}
