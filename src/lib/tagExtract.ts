/**
 * Разбор обозначений тегов: разбиение кода на сегменты и поиск обозначений в
 * тексте документации.
 *
 * Без React и без сети — чистые функции, поэтому лежат в lib/, а не рядом с
 * хуками раздела «Теги». Вынесены из Registry.tsx как есть.
 */

// Regex splitting utility
export function splitSegments(str: string): string[] {
  if (!str) return [];
  return str.split(/[-.,\/ ]+/).filter(Boolean);
}

/** Обозначения, найденные в тексте, без повторов (порядок — как в тексте) */
export function findTagCandidates(text: string): string[] {
  // Match patterns that look like components with separators
  // e.g. 3700-C01-HVC-001 or 01/AHU-001 or TE.101 etc.
  // Minimum length 4 characters, containing at least one of the separators
  const regex = /([a-zA-Z0-9А-Яа-яЁё]+(?:[\-\.\/\\_][a-zA-Z0-9А-Яа-яЁё]+)+)/g;
  const matches = text.match(regex) || [];

  // De-duplicate
  return Array.from(new Set(matches.map(m => m.trim()))) as string[];
}
