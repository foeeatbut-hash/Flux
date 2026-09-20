/**
 * Руководство по программе: устройство статьи и поиск по ним.
 *
 * Главная беда встроенной справки — она врёт. Раздел переименовали, право
 * убрали, таблицу переделали, а в тексте всё по-старому; человек один раз
 * ловит её на неправде и больше не открывает.
 *
 * Поэтому статья — не сплошной текст, а разбор: проза объясняет «зачем», а
 * проверяемые факты объявлены полями. Что раздел хранит (`stores`), как это
 * связано (`links`), какие права нужны (`perms`), по какому адресу живёт
 * (`route`) — всё это имена настоящих моделей Prisma, прав из каталога и
 * разделов из реестра. `scripts/test-handbook.ts` сверяет каждое имя с кодом:
 * переименовали модель — набор проверок падает, и статью правят вместе с ней.
 *
 * Модуль чистый: ни React, ни обращений к серверу — поэтому его и получается
 * покрыть проверками.
 */

/** Что можно сделать: одно дело и порядок действий. */
export interface HandbookTask {
  title: string;
  /** Шаги по порядку. Пишем как говорим человеку, а не как устроен код. */
  steps: string[];
  /** Замечание к делу: когда пригодится, чем чревато */
  note?: string;
}

/** Связь между хранимыми сущностями: «от» — «к» — чем связаны. */
export type HandbookLink = [from: string, to: string, via: string];

export interface HandbookArticle {
  id: string;
  title: string;
  /** Путь раздела программы. Пусто — сквозная тема, а не раздел */
  route?: string;
  /** Группа в оглавлении */
  group: 'start' | 'sections' | 'data' | 'admin';
  /** Одно-два предложения: зачем этот раздел вообще нужен */
  lead: string;
  /** Почему устроено именно так — то, чего не видно из интерфейса */
  why?: string;
  tasks: HandbookTask[];
  /** Модели Prisma, в которых лежат данные раздела */
  stores?: string[];
  /** Связи между моделями — рисуем картой */
  links?: HandbookLink[];
  /** Права из каталога src/lib/permissions.ts */
  perms?: string[];
  /**
   * Статья о встроенной программе, доступ к которой выдаётся отдельно
   * (src/lib/appPolicy.ts). Без права её нет ни в оглавлении, ни в поиске:
   * статья — самый простой способ узнать, что такая программа существует.
   */
  entitlement?: string;
  /** Сочетания клавиш: клавиша — что делает */
  keys?: Array<[keys: string, does: string]>;
  /** Что легко сделать не так */
  pitfalls?: string[];
  /** Смежные статьи по id */
  see?: string[];
  /** Слова для поиска, которых нет в тексте: как это называют вслух */
  also?: string[];
}

// ── Поиск ────────────────────────────────────────────────────────────────────
//
// Поиск идёт по заранее собранной строке: заголовок, подзаголовки, шаги, слова
// «как это называют вслух». Приводим к нижнему регистру заранее — LIKE и
// toLowerCase на кириллице работают, а вот сравнение по ходу перебора на
// сотне статей заметно медленнее, чем один раз при сборке.

export interface HandbookIndexEntry {
  article: HandbookArticle;
  haystack: string;
  /** Как это называют вслух — отдельно: совпадение здесь весит больше */
  also: string[];
}

/** Буква «ё» пишется и как «е» — ищущий не обязан помнить, как в тексте. */
export const foldRu = (s: string): string => s.toLowerCase().replace(/ё/g, 'е');

export function indexOf(articles: HandbookArticle[]): HandbookIndexEntry[] {
  return articles.map((a) => ({
    article: a,
    also: (a.also || []).map(foldRu),
    haystack: foldRu([
      a.title, a.lead, a.why || '',
      ...a.tasks.map((t) => `${t.title} ${t.steps.join(' ')} ${t.note || ''}`),
      ...(a.pitfalls || []),
      ...(a.also || []),
      ...(a.stores || []),
    ].join(' ')),
  }));
}

export interface HandbookHit {
  article: HandbookArticle;
  /** Насколько уверенно: попадание в заголовок весит больше, чем в текст */
  score: number;
  /** Кусок текста вокруг совпадения — показать в списке находок */
  excerpt: string;
}

export function searchHandbook(index: HandbookIndexEntry[], queryRaw: string, limit = 20): HandbookHit[] {
  const q = foldRu(queryRaw.trim());
  if (q.length < 2) return [];
  // Ищем по всем словам запроса: «как удалить тег» не должно находить всё,
  // где встречается «как»
  const words = q.split(/\s+/).filter((w) => w.length >= 2);
  if (!words.length) return [];

  const hits: HandbookHit[] = [];
  for (const entry of index) {
    if (!words.every((w) => entry.haystack.includes(w))) continue;
    const title = foldRu(entry.article.title);
    const lead = foldRu(entry.article.lead);
    let score = 0;
    // Запрос целиком совпал с тем, как это называют вслух, — это самый
    // сильный сигнал: «кто что может» задумано как вход в статью о правах,
    // хотя ни одного из этих слов нет ни в заголовке, ни во вступлении
    if (entry.also.some((phrase) => phrase.includes(q) || q.includes(phrase))) score += 25;
    if (title.includes(q)) score += 20;
    for (const w of words) {
      if (title.includes(w)) score += 10;
      if (lead.includes(w)) score += 4;
      if (entry.also.some((phrase) => phrase.includes(w))) score += 3;
      if (entry.haystack.includes(w)) score += 1;
    }
    hits.push({ article: entry.article, score, excerpt: excerptAround(entry.haystack, words[0]) });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

function excerptAround(text: string, word: string, span = 90): string {
  const at = text.indexOf(word);
  if (at < 0) return text.slice(0, span);
  const from = Math.max(0, at - Math.floor(span / 3));
  const cut = text.slice(from, from + span).trim();
  return (from > 0 ? '…' : '') + cut + (from + span < text.length ? '…' : '');
}

// ── Оглавление ───────────────────────────────────────────────────────────────

export const GROUPS: Array<{ id: HandbookArticle['group']; title: string; hint: string }> = [
  { id: 'start', title: 'С чего начать', hint: 'Первые шаги и общее устройство' },
  { id: 'sections', title: 'Разделы', hint: 'Что умеет каждый раздел' },
  { id: 'data', title: 'Данные и связи', hint: 'Что где хранится и чем связано' },
  { id: 'admin', title: 'Права и обслуживание', hint: 'Доступы, копии, лицензия' },
];

export function byGroup(articles: HandbookArticle[], group: HandbookArticle['group']): HandbookArticle[] {
  return articles.filter((a) => a.group === group);
}

/** Статья раздела программы по его пути — для входа из самого раздела. */
export function articleForRoute(articles: HandbookArticle[], route: string): HandbookArticle | null {
  return articles.find((a) => a.route === route) || null;
}

/** Якоря статьи: то, что показываем в поле «на этой странице». */
export function anchorsOf(a: HandbookArticle): Array<{ id: string; title: string }> {
  const out: Array<{ id: string; title: string }> = [];
  if (a.why) out.push({ id: 'why', title: 'Почему так' });
  if (a.tasks.length) out.push({ id: 'tasks', title: 'Что можно сделать' });
  if (a.stores?.length || a.links?.length) out.push({ id: 'data', title: 'Что хранится' });
  if (a.perms?.length) out.push({ id: 'perms', title: 'Права' });
  if (a.keys?.length) out.push({ id: 'keys', title: 'Клавиши' });
  if (a.pitfalls?.length) out.push({ id: 'pitfalls', title: 'На что напороться' });
  return out;
}
