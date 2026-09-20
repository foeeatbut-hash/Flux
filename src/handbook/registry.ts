import { CORE_ARTICLES } from './coreArticles';
import { WORK_ARTICLES } from './workArticles';
import { TOPIC_ARTICLES } from './topicArticles';
import { indexOf, searchHandbook, articleForRoute, type HandbookArticle, type HandbookHit } from './model';

/**
 * Все статьи руководства в одном месте — и поиск по ним.
 *
 * Порядок здесь задаёт порядок в оглавлении: сначала как начать, потом
 * разделы в том же порядке, в каком они стоят в Пуске, потом данные и
 * обслуживание. Человек ищет статью там же, где привык видеть сам раздел.
 */
export const ARTICLES: HandbookArticle[] = [
  ...CORE_ARTICLES,
  ...WORK_ARTICLES,
  ...TOPIC_ARTICLES,
];

export const BY_ID = new Map(ARTICLES.map((a) => [a.id, a]));

/** Собирается один раз при загрузке модуля: перебор строк дешевле сборки. */
const INDEX = indexOf(ARTICLES);

/**
 * Статьи, открытые этому человеку.
 *
 * Решение принимает политика (src/lib/appPolicy.ts), а сюда приходит готовым:
 * реестр остаётся чистым и проверяемым, а правило доступа — одно на программу.
 */
export function openTo(list: HandbookArticle[], allow: (entitlement: string) => boolean): HandbookArticle[] {
  return list.filter((a) => !a.entitlement || allow(a.entitlement));
}

export function search(query: string, limit = 20, allow?: (entitlement: string) => boolean): HandbookHit[] {
  const hits = searchHandbook(INDEX, query, allow ? limit * 2 : limit);
  if (!allow) return hits;
  return hits.filter((h) => !h.article.entitlement || allow(h.article.entitlement)).slice(0, limit);
}

export function articleById(id: string): HandbookArticle | null {
  return BY_ID.get(id) || null;
}

export function forRoute(route: string): HandbookArticle | null {
  return articleForRoute(ARTICLES, route);
}

export type { HandbookArticle, HandbookHit };
