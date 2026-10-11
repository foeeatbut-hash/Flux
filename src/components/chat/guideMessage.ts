/**
 * Метка хранится в самом сообщении, чтобы запрос оставался понятен и после
 * перезапуска клиента, когда локальный переключатель F уже сброшен.
 */
export type GuideMessageKind = 'request' | 'reply' | null;

export function parseGuideMessage(content: string): { kind: GuideMessageKind; text: string } {
  const value = String(content || '');
  const request = value.match(/^Запрос Flux Guide:\s?/);
  if (request) return { kind: 'request', text: value.slice(request[0].length) };
  const reply = value.match(/^F · Flux Guide(?:\r?\n){1,2}/);
  if (reply) return { kind: 'reply', text: value.slice(reply[0].length) };
  return { kind: null, text: value };
}
