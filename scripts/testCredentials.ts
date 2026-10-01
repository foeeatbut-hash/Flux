/** Учётные данные для проверок против работающего сервера. */
export function testCredentials(env: NodeJS.ProcessEnv = process.env): { symbol: string; password: string } {
  const symbol = env.FLUX_USER?.trim();
  const password = env.FLUX_PASS;
  if (!symbol || !password) {
    throw new Error('Для live-проверки задайте FLUX_USER и FLUX_PASS; рабочие учётные данные по умолчанию не используются.');
  }
  return { symbol, password };
}
