/** Общие проверки и ожидание готовности для live сценариев Office. */
export function createNativeCheck(onFailure: () => void) {
  return (label: string, good: unknown, detail?: unknown) => {
    if (good) console.log(`  ✓ ${label}`);
    else { onFailure(); console.error(`  ✗ ${label}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)); }
  };
}

/** Опрос готовности оставляет тот же интервал, timeout и финальную пробу, что и driver. */
export async function waitFor(probe: () => Promise<boolean>, timeout = 15000): Promise<boolean> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await probe()) return true; await new Promise((resolve) => setTimeout(resolve, 250)); }
  return probe();
}
