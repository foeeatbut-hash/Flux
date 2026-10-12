/** Мост отвечает именем события без requestId: одинаковые запросы отправляем по очереди. */
export function queueOfficeReply<T>(queue: Map<string, Promise<unknown>>, channel: string, request: () => Promise<T>): Promise<T> {
  const previous = queue.get(channel) || Promise.resolve();
  const task = previous.catch(() => undefined).then(request);
  queue.set(channel, task);
  void task.then(() => { if (queue.get(channel) === task) queue.delete(channel); }, () => { if (queue.get(channel) === task) queue.delete(channel); });
  return task;
}
