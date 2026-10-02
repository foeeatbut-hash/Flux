/** Runs writes in order, reading their concurrency token from the latest state. */
export function createSerializedStateWriter<State, Input, Output>(
  readState: () => State | null,
  write: (input: Input, state: State) => Promise<Output>,
) {
  let pending: Promise<Output> | null = null;
  return (input: Input): Promise<Output> => {
    const previous = pending || Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => {
      const state = readState();
      if (state === null) throw new Error('Нечего сохранять: файл ещё не открыт.');
      return write(input, state);
    });
    // Занимаем место в очереди до ожидания, иначе несколько вызовов стартуют вместе.
    pending = operation;
    return operation.finally(() => { if (pending === operation) pending = null; });
  };
}
