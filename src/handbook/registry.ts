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

export function search(query: string, limit = 20): HandbookHit[] {
  return searchHandbook(INDEX, query, limit);
}

export function articleById(id: string): HandbookArticle | null {
  return BY_ID.get(id) || null;
}

export function forRoute(route: string): HandbookArticle | null {
  return articleForRoute(ARTICLES, route);
}

export type { HandbookArticle, HandbookHit };
