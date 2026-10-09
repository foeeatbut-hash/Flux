/**
 * Ожидание редактора ограничено: панель Flux не должна терять раннюю команду,
 * но команда не может примениться после того, как окно показало таймаут.
 */
export async function waitForEditor<T>(
  read: () => T | null | undefined,
  timeoutMs: number,
  pollMs = 50,
): Promise<T | null> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (Date.now() < deadline) {
    const value = read()
    if (value) return value
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())))
  }
  return null
}
