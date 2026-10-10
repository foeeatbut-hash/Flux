type ProfileResponse<TUser> = {
  ok: boolean;
  status: number;
  json: () => Promise<{ user?: TUser | null }>;
};

type RestoreOptions = {
  timeoutMs?: number;
  retryDelaysMs?: number[];
  wait?: (ms: number) => Promise<void>;
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function transientNetworkFailure(error: unknown): boolean {
  const name = error && typeof error === 'object' && 'name' in error ? String((error as any).name) : '';
  // Fetch использует TypeError для отсутствующего listener, а TimeoutError
  // создаёт наш предел ожидания; остальные ошибки не должны маскироваться повторами.
  return name === 'TypeError' || name === 'TimeoutError';
}

function requestWithTimeout<T>(request: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      const error = new Error('Startup request timed out');
      error.name = 'TimeoutError';
      reject(error);
    }, timeoutMs);
    Promise.resolve().then(() => request(controller.signal)).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** Восстанавливает сохранённый профиль при старте, ограничивая повторы только сетевыми сбоями. */
export async function restoreStartupUser<TUser extends { id?: string }>(
  request: (signal: AbortSignal) => Promise<ProfileResponse<TUser>>,
  options: RestoreOptions = {},
): Promise<TUser | null> {
  const timeoutMs = options.timeoutMs ?? 2500;
  const retryDelaysMs = options.retryDelaysMs ?? [200, 500];
  const pause = options.wait ?? wait;

  for (let attempt = 0; ; attempt++) {
    let response: ProfileResponse<TUser>;
    try {
      response = await requestWithTimeout(request, timeoutMs);
    } catch (error) {
      if (!transientNetworkFailure(error) || attempt >= retryDelaysMs.length) return null;
      await pause(retryDelaysMs[attempt]);
      continue;
    }

    // 401/403 и остальные HTTP-ответы — решение сервера, а не сбой связи.
    // Их сразу оставляем существующему экрану входа; сохранённый токен не меняем.
    if (!response.ok) return null;
    const data = await response.json();
    return data.user?.id ? data.user : null;
  }
}
