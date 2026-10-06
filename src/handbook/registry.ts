import { CORE_ARTICLES } from './coreArticles';
import { WORK_ARTICLES } from './workArticles';
import { TOPIC_ARTICLES } from './topicArticles';
import { BUILDER_ARTICLES } from './builderArticles';
import { NATIVE_ARTICLES } from './nativeArticles';
import { indexOf, searchHandbook, articleForRoute, type HandbookArticle, type HandbookHit } from './model';
import { resolveSectionPath } from '../lib/sectionAliases';
import { playEnabled } from '../../play/enabled';

/**
 * Все статьи руководства в одном месте — и поиск по ним.
 *
 * Порядок здесь задаёт порядок в оглавлении: сначала как начать, потом
 * разделы в том же порядке, в каком они стоят в Пуске, потом данные и
 * обслуживание. Человек ищет статью там же, где привык видеть сам раздел.
 */
export const ARTICLES: HandbookArticle[] = [
  ...CORE_ARTICLES,
  // Статья про Flux Play — только при включённой платформе: о закрытом разделе
  // руководство молчит так же, как Пуск
  ...WORK_ARTICLES.filter((a) => a.id !== 'play' || playEnabled()),
  ...BUILDER_ARTICLES,
  ...NATIVE_ARTICLES,
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
  const value = String(route || '');
  const path = value.split(/[?#]/, 1)[0];
  if (path === '/explorer' && new URLSearchParams(value.slice(path.length + 1)).get('view') === 'shared') {
    return articleForRoute(ARTICLES, '/shared-files');
  }
  return articleForRoute(ARTICLES, path) || articleForRoute(ARTICLES, resolveSectionPath(path));
}

export type { HandbookArticle, HandbookHit };
