/**
 * ФИО сотрудника в нужном виде.
 *
 * Раньше лежало в docFormula.ts рядом с «формулами документа». Формулы
 * удалены, а вид ФИО нужен и без них: подпись в шапке (Layout) и редактор
 * подписи (SignatureEditor) показывают «Раупов Х.Х.». Проверки —
 * scripts/test-names.ts.
 */

export type NameFormat = 'full' | 'initialsAfter' | 'initialsBefore' | 'last';

/** ФИО по частям → нужный вид. Части приходят из профиля сотрудника. */
export function formatName(
  parts: { lastName?: string; firstName?: string; middleName?: string; name?: string },
  fmt: NameFormat = 'full',
): string {
  const last = (parts.lastName || '').trim();
  const first = (parts.firstName || '').trim();
  const mid = (parts.middleName || '').trim();
  // Профиль заведён до раздельного хранения — разбираем единую строку
  if (!last && parts.name) {
    const bits = String(parts.name).trim().split(/\s+/);
    return formatName({ lastName: bits[0], firstName: bits[1], middleName: bits[2] }, fmt);
  }
  if (!last && !first) return '';
  const i1 = first ? first[0].toUpperCase() + '.' : '';
  const i2 = mid ? mid[0].toUpperCase() + '.' : '';
  // Инициалы пишутся слитно — «Раупов Х.Х.», как принято в штампах отдела.
  // Между фамилией и инициалами неразрывный пробел: «Раупов Х.Х.» не должно
  // переноситься по строке — это одна подпись, а не два слова.
  const NB = ' ';
  const ini = i1 + i2;                       // «Х.Х.» без пробела внутри
  switch (fmt) {
    case 'last': return last;
    case 'initialsAfter': return [last, ini].filter(Boolean).join(NB);
    case 'initialsBefore': return [ini, last].filter(Boolean).join(NB);
    default: return [last, first, mid].filter(Boolean).join(' ');
  }
}
