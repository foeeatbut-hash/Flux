/**
 * Метка хранится в самом сообщении, чтобы запрос оставался понятен и после
 * перезапуска клиента, когда локальный переключатель F уже сброшен.
 */
export type GuideMessageKind = 'request' | 'reply' | null;

export function parseGuideMessage(content: string, markers: { guideRequest?: boolean; guideReply?: boolean } = {}): { kind: GuideMessageKind; text: string } {
  const value = String(content || '');
  if (markers.guideRequest) return { kind: 'request', text: value };
  if (markers.guideReply) {
    const reply = value.match(/^F · Flux Guide(?:\r?\n){1,2}/);
    return { kind: 'reply', text: reply ? value.slice(reply[0].length) : value };
  }
  return { kind: null, text: value };
}
