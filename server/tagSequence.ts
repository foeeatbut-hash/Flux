/**
 * Следующий код тега по префиксу: «P-» + номер + суффикс.
 *
 * Вынесено из маршрута, чтобы правила нумерации проверялись без сервера.
 */

/** Три знака, пока в проекте нет ни одного тега с этим префиксом */
const DEFAULT_PAD = 3;

export function nextTagIdentifier(existing: string[], prefix: string, suffix = ''): string {
  let maxSeq = 0;
  let pad = 0;
  for (const ident of existing) {
    // Сравнение с учётом регистра на всех движках: SQLite и MariaDB в startsWith
    // его не различают, PostgreSQL различает, и код «p-01» не должен считаться «P-01»
    if (!ident.startsWith(prefix)) continue;
    let seqStr = ident.slice(prefix.length);
    if (suffix) {
      // Тег другой серии (K005, когда ищем K…B) в нумерацию этой серии не входит
      if (!seqStr.endsWith(suffix)) continue;
      seqStr = seqStr.slice(0, -suffix.length);
    }
    // Только чисто числовой номер: parseInt("001_V2") вернул бы 1
    if (!/^\d+$/.test(seqStr)) continue;
    const num = parseInt(seqStr, 10);
    if (num > maxSeq || (num === maxSeq && seqStr.length > pad)) {
      maxSeq = num;
      // Разрядность берём у тега с наибольшим номером: P-01…P-09 продолжаются как P-10, а не P-010
      pad = seqStr.length;
    }
  }
  return `${prefix}${String(maxSeq + 1).padStart(pad || DEFAULT_PAD, '0')}${suffix}`;
}
