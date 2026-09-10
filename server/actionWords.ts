/**
 * Действие человека — человеческой фразой.
 *
 * Журнал раньше писал то, что удобно программе: метод и адрес запроса.
 * «POST /api/files» ничего не говорит тому, кто разбирается, кто удалил
 * ведомость; а разбираются по журналу именно люди. Поэтому здесь адрес
 * превращается в фразу: «Загрузил файл», «Удалил тег», «Опубликовал релиз».
 *
 * Правила отдельным модулем, потому что у них есть правильный ответ и его
 * проверяет скрипт (scripts/test-action-log.ts). Незнакомый адрес не выдумывает
 * фразу — он честно называет действие как есть, иначе журнал начнёт врать.
 */

export interface ActionWords {
  /** Что сделал: «Загрузил файл» */
  what: string;
  /** Над чем: идентификатор или имя, если он есть в адресе */
  target: string;
  /** Куда идти смотреть */
  route: string;
}

/** Часть адреса после /api/ и до первого идентификатора */
const headOf = (path: string): string[] =>
  String(path || '').replace(/^\/api\//, '').split('?')[0].split('/').filter(Boolean);

const VERB: Record<string, string> = {
  POST: 'Создал',
  PUT: 'Изменил',
  PATCH: 'Изменил',
  DELETE: 'Удалил',
};

/** Разделы: и слово для фразы, и адрес, по которому это открыть */
const AREA: Record<string, { word: string; route: string }> = {
  projects: { word: 'проект', route: '/projects' },
  tags: { word: 'тег', route: '/registry' },
  files: { word: 'файл', route: '/explorer' },
  folders: { word: 'папку', route: '/explorer' },
  equipment: { word: 'оборудование', route: '/equipment' },
  components: { word: 'изделие', route: '/equipment' },
  constructor: { word: 'документ', route: '/constructor' },
  notes: { word: 'заметку', route: '/notes' },
  calendar: { word: 'событие календаря', route: '/calendar' },
  chat: { word: 'сообщение', route: '/chat' },
  mail: { word: 'письмо', route: '/mail' },
  users: { word: 'сотрудника', route: '/users' },
  vdr: { word: 'строку ВДР', route: '/management' },
  procurement: { word: 'закупку', route: '/management' },
  updates: { word: 'обновление', route: '/settings?section=updates' },
  dictionaries: { word: 'справочник', route: '/directory' },
};

/**
 * Отдельные случаи, где глагол по методу врёт: вход — не «создание сессии», а
 * выгрузка обновления — не «создание файла».
 */
const SPECIAL: { test: (m: string, p: string[]) => boolean; what: string; route: string }[] = [
  { test: (m, p) => m === 'POST' && p[0] === 'login', what: 'Вошёл в программу', route: '/' },
  { test: (m, p) => m === 'POST' && p[0] === 'logout', what: 'Вышел из программы', route: '/' },
  { test: (m, p) => p[0] === 'updates' && p[1] === 'upload', what: 'Загрузил файл обновления', route: '/settings?section=updates' },
  { test: (m, p) => m === 'POST' && p[0] === 'updates' && !p[1], what: 'Опубликовал релиз', route: '/settings?section=updates' },
  { test: (m, p) => m === 'DELETE' && p[0] === 'updates', what: 'Отозвал релиз', route: '/settings?section=updates' },
  { test: (m, p) => m === 'POST' && p[0] === 'users' && p[2] === 'permissions', what: 'Изменил права сотрудника', route: '/users' },
  { test: (m, p) => m === 'PUT' && p[0] === 'users' && p[2] === 'permissions', what: 'Изменил права сотрудника', route: '/users' },
  { test: (m, p) => p[0] === 'constructor' && p[1] === 'docs' && p[2] === 'import-file', what: 'Открыл файл в Flux Office', route: '/sheet' },
];

/** Идентификатор из адреса, если он там есть: по нему запись и находят */
function targetOf(parts: string[]): string {
  for (const part of parts.slice(1)) {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(part) || /^\d+\.\d+\.\d+/.test(part)) return part;
  }
  return '';
}

export function describeAction(method: string, path: string): ActionWords | null {
  const m = String(method || '').toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return null;
  const parts = headOf(path);
  if (!parts.length) return null;

  for (const s of SPECIAL) {
    if (s.test(m, parts)) return { what: s.what, target: targetOf(parts), route: s.route };
  }

  const area = AREA[parts[0]];
  const verb = VERB[m] || 'Выполнил';
  if (!area) {
    // Незнакомый адрес не выдумывается: пишем как есть, чтобы журнал не врал
    return { what: `${verb}: ${parts.join('/')}`, target: targetOf(parts), route: '/' };
  }
  return { what: `${verb} ${area.word}`, target: targetOf(parts), route: area.route };
}

/** Адреса, которые в журнал не пишутся: они не действия человека */
const SKIP = [
  'logs', 'presence', 'notifications', 'health', 'limits', 'license',
  'assistant', 'insight', 'translate', 'constructor/fn',
  // Куски вложения: файл на сорок мегабайт — это полторы сотни запросов, и
  // каждый оставил бы в журнале действий свою строку. Само обращение при этом
  // в журнал попадает: оно одно на весь файл
  'feedback/uploads',
];

export function isNoise(path: string): boolean {
  const parts = headOf(path);
  if (!parts.length) return true;
  return SKIP.includes(parts[0]) || SKIP.includes(`${parts[0]}/${parts[1]}`);
}
