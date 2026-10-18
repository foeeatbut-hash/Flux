import {
  runNativeDefinedNamesReloadScenario,
  type NativeDefinedNamesReloadContext,
} from './officeNativeDefinedNamesReloadScenario';

export async function runNativeDefinedNamesReloadPreflight(ctx: NativeDefinedNamesReloadContext): Promise<void> {
  await runNativeDefinedNamesReloadScenario({
    ...ctx,
    check: (label, good, detail) => {
      ctx.check(label, good, detail);
      if (!good) throw new Error(`Defined-name reload preflight failed: ${label}`);
    },
  });
}

/** Preflight запускается в полном режиме и отдельно по запросу; узкие старые режимы сохраняют порядок. */
export async function runNativeDefinedNamesReloadMode(
  nativeOnly: string,
  ctx: NativeDefinedNamesReloadContext,
  closeContext: () => Promise<unknown>,
): Promise<boolean> {
  if (!nativeOnly || nativeOnly === 'names-reload') await runNativeDefinedNamesReloadPreflight(ctx);
  if (nativeOnly !== 'names-reload') return false;
  await closeContext();
  return true;
}
