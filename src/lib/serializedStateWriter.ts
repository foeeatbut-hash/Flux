/** Runs writes in order, reading their concurrency token from the latest state. */
export function createSerializedStateWriter<State, Input, Output>(
  readState: () => State | null,
  write: (input: Input, state: State) => Promise<Output>,
) {
  let pending: Promise<Output> | null = null;
  return async (input: Input): Promise<Output> => {
    if (pending) await pending.catch(() => undefined);
    const state = readState();
    if (state === null) throw new Error('Нечего сохранять: файл ещё не открыт.');
    const operation = Promise.resolve().then(() => write(input, state));
    pending = operation;
    try { return await operation; }
    finally { if (pending === operation) pending = null; }
  };
}
