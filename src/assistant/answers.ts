import { ENV_CONFIG } from '../config/env';
import { say, type AssistantMessage } from './types';
import { answerFromHandbook, handbookHref } from './handbookAnswers';
import { parseMailQuery } from './mailQueries';

/**
 * Два ответа, которых у помощника раньше не было: из руководства и из почты.
 *
 * Руководство. В нём два десятка статей, а помощник отвечал из своего
 * короткого набора заготовок и на всё остальное разводил руками. Теперь
 * вопрос уходит в тот же поиск, которым пользуется само руководство, а в
 * переписку попадает не название статьи, а тот её кусок, который отвечает на
 * вопрос, — и переход, открывающий руководство прямо на этом месте.
 *
 * Почта. «Покажи все письма про 20-PT-001», «письма от Иванова» — вопрос
 * задаётся словами, а искать надо по всем ящикам сразу: в каком из них лежит
 * нужное письмо, спрашивающий как раз и не знает.
 */

/** Ответ из руководства: кусок статьи и переход в это самое место. */
export function handbookMessage(
  question: string,
  minScore: number,
  allow?: (entitlement: string) => boolean,
): AssistantMessage | null {
  const ans = answerFromHandbook(question, minScore, allow);
  if (!ans) return null;
  return say(`${ans.text}\n\nЭто в руководстве: «${ans.articleTitle}» → ${ans.anchorTitle}.`, {
    actions: [{
      label: `Открыть: ${ans.articleTitle} → ${ans.anchorTitle}`,
      kind: 'navigate',
      route: handbookHref(ans),
    }],
  });
}

interface FoundMail {
  total: number;
  messages: Array<{
    id: string; subject: string; fromName: string; fromAddr: string;
    sentAt: string; accountLabel: string;
  }>;
}

/** Поиск писем по всем доступным ящикам. null — до почты не достучались. */
async function findMail(q: string, from: string): Promise<FoundMail | null> {
  try {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (from) p.set('from', from);
    p.set('limit', '8');
    // Заголовок входа подставляет обёртка над fetch (src/config/env.ts)
    const r = await fetch(`${ENV_CONFIG.apiUrl}/mail/find?${p}`);
    if (!r.ok) return null;
    const d = await r.json();
    return { total: Number(d.total) || 0, messages: Array.isArray(d.messages) ? d.messages : [] };
  } catch (_) {
    return null;
  }
}

const openMail = (route: string, label = 'Открыть Почту') =>
  ([{ label, kind: 'navigate' as const, route }]);

/** Ответ поиском по почте. Возвращает готовое сообщение. */
export async function mailSearchMessage(question: string): Promise<AssistantMessage> {
  const mq = parseMailQuery(question);
  if (!mq) {
    return say('Открываю почту. Скажите, что искать: «письма про 20-PT-001» или «письма от Иванова».',
      { actions: openMail('/mail') });
  }

  const found = await findMail(mq.q, mq.from);
  if (found === null) {
    return say('Не смог обратиться к почте. Проверьте, подключён ли ящик в разделе «Почта».',
      { actions: openMail('/mail') });
  }

  const href = `/mail?q=${encodeURIComponent(mq.q || mq.from)}`;
  if (!found.messages.length) {
    return say(
      `Писем ${mq.label} не нашёл. Возможно, они в ящике, который ещё не подключён, или глубже, чем скачано.`,
      { actions: openMail(href) },
    );
  }

  const more = found.total > found.messages.length ? `, показываю ${found.messages.length} свежих` : '';
  return say(`Писем ${mq.label}: ${found.total}${more}.`, {
    list: found.messages.map((m) => ({
      id: m.id,
      title: m.subject || 'Без темы',
      subtitle: [
        m.fromName || m.fromAddr,
        new Date(m.sentAt).toLocaleDateString('ru-RU'),
        m.accountLabel,
      ].filter(Boolean).join(' · '),
      actions: openMail(href, 'Открыть'),
    })),
    actions: openMail(href, 'Открыть все в Почте'),
  });
}
