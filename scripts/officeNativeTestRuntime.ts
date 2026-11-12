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

/**
 * До загрузки содержимого кадр — заглушка с origin 'null', и postMessage с таким origin
 * родитель не принимает: ждём, пока в кадре откроется настоящий редактор.
 */
export async function waitFrameLoaded(page: any, frame: any, title: string, timeout = 30000): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const loaded = await frame.locator('body').evaluate(() => location.origin !== 'null' && /\/genoffice\//.test(location.href) && document.readyState === 'complete').catch(() => false);
    if (loaded) return;
    if (Date.now() > deadline) throw new Error(`Кадр "${title}" не загрузил содержимое за ${timeout / 1000} с (origin остался заглушкой)`);
    await page.waitForTimeout(200);
  }
}

/** Просьба открыть панель Flux Office из загруженного кадра редактора: то же сообщение, что шлёт кнопка ленты */
export async function requestPanel(page: any, frame: any, title: string): Promise<void> {
  await waitFrameLoaded(page, frame, title);
  await frame.locator('body').evaluate(() => { window.parent.postMessage({ flux: 'office', op: 'flux:open-panel' }, location.origin); });
}
