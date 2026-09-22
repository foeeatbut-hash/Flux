import { ARTICLES, type HandbookArticle } from '../handbook/registry';
import { indexOf, foldRu } from '../handbook/model';
import { stem } from './nlp';

/**
 * Ответы помощника из руководства.
 *
 * Раньше помощник и руководство жили порознь: в руководстве двадцать с лишним
 * статей, а помощник отвечал из своего короткого набора заготовок и на всё
 * остальное разводил руками. Спросить «где написано про подписи в письмах»
 * было некуда: в помощнике этого нет, а в руководстве надо сперва угадать,
 * в какой статье искать.
 *
 * Теперь вопрос подбирает статью сам, а ответом становится её кусок — не вся
 * статья и не её название, а именно то место, которое отвечает на вопрос.
 * Рядом — переход, открывающий руководство на этом самом месте (см. ?at= в
 * src/screens/Handbook).
 *
 * Модуль чистый: ни React, ни сети — только текст на входе и на выходе.
 */

export interface HandbookAnswer {
  /** Что сказать в переписке */
  text: string;
  articleId: string;
  articleTitle: string;
  /** Место в статье: why | tasks | data | perms | keys | pitfalls */
  anchor: string;
  /** Как называется это место — для подписи на кнопке */
  anchorTitle: string;
}

const ANCHOR_TITLE: Record<string, string> = {
  why: 'Почему так',
  tasks: 'Что можно сделать',
  data: 'Что хранится',
  perms: 'Права',
  keys: 'Клавиши',
  pitfalls: 'На что напороться',
};

/**
 * Слова вопроса, по которым имеет смысл сравнивать.
 *
 * Отбрасываем короткие и служебные — «где», «как», «про», «руководстве». Без
 * этого «где в руководстве про подписи» уводило в статью о самом руководстве:
 * слово «руководстве» встречается там чаще всего остального.
 *
 * Остальные приводим к основе: человек спрашивает «проектные данные», а в
 * статье написано «данные проекта». Без основы эти два слова не совпадают
 * вовсе, и статья, написанная ровно про это, не находится.
 */
const SKIP = new Set([
  'где', 'как', 'что', 'это', 'про', 'для', 'чтобы', 'можно', 'нужно', 'если', 'когда',
  'такое', 'руководстве', 'руководство', 'справке', 'справка', 'написано', 'посмотреть',
  'найти', 'подскажи', 'скажи', 'покажи', 'почитать', 'узнать', 'вообще', 'здесь', 'тут',
  'мне', 'меня', 'нам', 'все', 'всех', 'чем', 'этом', 'этой', 'него', 'нее', 'оно',
]);

function words(q: string): string[] {
  const out: string[] = [];
  for (const raw of foldRu(q).replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/)) {
    if (raw.length < 4 || SKIP.has(raw)) continue;
    const st = stem(raw);
    if (st.length >= 3 && !out.includes(st)) out.push(st);
  }
  return out;
}

/** Сколько основ вопроса встретилось в куске текста. */
function hits(text: string, ws: string[]): number {
  const hay = foldRu(text);
  let n = 0;
  for (const w of ws) if (hay.includes(w)) n++;
  return n;
}

/**
 * Ближайшая статья.
 *
 * Свой отбор, а не поиск руководства: тот требует, чтобы в статье нашлись все
 * слова запроса, и это верно для строки поиска, но не для живого вопроса —
 * в «как вернуть удалённый файл из корзины» половина слов в статье не
 * встречается никогда.
 *
 * Здесь требование мягче: должна найтись хотя бы половина значимых основ.
 * Совсем без требования одна общая «почта» притягивала бы статью о почте к
 * любому вопросу, где это слово случайно прозвучало.
 */
const INDEX = indexOf(ARTICLES);

function bestArticle(ws: string[]): { article: HandbookArticle; score: number } | null {
  if (!ws.length) return null;
  let best: { article: HandbookArticle; score: number } | null = null;

  for (const e of INDEX) {
    const title = foldRu(e.article.title);
    const lead = foldRu(e.article.lead);
    let found = 0;
    let score = 0;
    for (const w of ws) {
      let s = 0;
      if (title.includes(w)) s += 10;
      if (e.also.some((phrase) => phrase.includes(w))) s += 6;
      if (lead.includes(w)) s += 4;
      if (e.haystack.includes(w)) s += 2;
      if (s) found++;
      score += s;
    }
    if (found * 2 < ws.length) continue;
    if (!best || score > best.score) best = { article: e.article, score };
  }
  return best;
}

/**
 * Какое место статьи отвечает на вопрос.
 *
 * Считаем совпадения слов по каждому куску отдельно. Перевес у «что можно
 * сделать»: человек спрашивает у помощника, как что-то сделать, куда чаще,
 * чем почему оно так устроено, и при равном счёте вести надо туда.
 */
function bestPart(a: HandbookArticle, ws: string[]): { anchor: string; text: string } {
  const parts: Array<{ anchor: string; text: string; score: number }> = [];

  for (const t of a.tasks) {
    const body = [t.title, ...t.steps, t.note || ''].join(' ');
    parts.push({
      anchor: 'tasks',
      text: `${t.title}: ${t.steps.join(' ')}${t.note ? ` ${t.note}` : ''}`,
      score: hits(body, ws) * 1.15 + 0.2,
    });
  }
  if (a.why) parts.push({ anchor: 'why', text: a.why.split(/\n{2,}/)[0], score: hits(a.why, ws) });
  if (a.pitfalls?.length) {
    for (const p of a.pitfalls) parts.push({ anchor: 'pitfalls', text: p, score: hits(p, ws) });
  }
  if (a.keys?.length) {
    const body = a.keys.map(([k, d]) => `${k} ${d}`).join('; ');
    parts.push({ anchor: 'keys', text: body, score: hits(body, ws) });
  }

  parts.sort((x, y) => y.score - x.score);
  // Ничего не зацепилось — отвечаем вводной статьи: она объясняет, зачем раздел
  if (!parts.length || parts[0].score <= 0.3) return { anchor: 'tasks', text: a.lead };
  return { anchor: parts[0].anchor, text: parts[0].text };
}

/** Слишком длинный кусок обрезаем по предложению, а не по букве. */
function shorten(text: string, max = 420): string {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const dot = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (dot > max * 0.5 ? cut.slice(0, dot + 1) : `${cut.trimEnd()}…`);
}

/**
 * Найти ответ в руководстве.
 *
 * `minScore` держим не на нуле: поиск по руководству отвечает почти на любой
 * набор букв, и без порога помощник начал бы притягивать статью к каждому
 * вопросу, включая те, на которые умеет отвечать сам и лучше.
 */
export function answerFromHandbook(
  question: string,
  minScore = 4,
  allow?: (entitlement: string) => boolean,
): HandbookAnswer | null {
  const q = String(question || '').trim();
  if (q.length < 3) return null;

  const ws = words(q);
  const found = bestArticle(ws);
  if (!found || found.score < minScore) return null;

  const a = found.article;
  // Статья о закрытой встроенной программе не отвечает никому, кроме тех, кому
  // она открыта: ответ помощника — такой же способ узнать о программе, как
  // строка поиска. Умолчание — отказ: забытый предикат не должен открывать
  if (a.entitlement && !(allow && allow(a.entitlement))) return null;
  const part = bestPart(a, ws);
  return {
    text: shorten(part.text),
    articleId: a.id,
    articleTitle: a.title,
    anchor: part.anchor,
    anchorTitle: ANCHOR_TITLE[part.anchor] || 'Начало статьи',
  };
}

/** Адрес перехода: статья и место в ней. */
export function handbookHref(ans: HandbookAnswer): string {
  return `/handbook?article=${encodeURIComponent(ans.articleId)}&at=${encodeURIComponent(ans.anchor)}`;
}

/**
 * Спрашивают именно «где это написано»? Тогда руководство отвечает первым,
 * даже если помощник сам что-то знает по теме.
 */
export function asksWhereWritten(q: string): boolean {
  const t = foldRu(q);
  return /(где (в )?(руководств|справк|инструкц|мануал)|в руководстве|в справке|почитать про|где написано|где посмотреть про|где найти про)/.test(t);
}
