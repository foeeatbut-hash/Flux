import type { ModuleApi } from '../../../contract';

/**
 * Пример подключения по HTTP: адрес и права объявлены в manifest.json, вызов идёт как есть.
 * Отказ человека — обычный исход: подпрограмма показывает, что работает без сервера.
 */
export function setup({ flux, state, calc, connect, log }: ModuleApi) {
  flux.on('changed', async () => {
    try {
      const reply = await connect.http('api', { method: 'GET', path: '/api/ping?from=flux' });
      state.status = reply.status;
      state.problem = 'нет';
      calc.out = { answer: String(JSON.parse(reply.body).answer) };
      log.info('сервер расчётов ответил');
    } catch (error) {
      // NOT_ALLOWED — человек не разрешил подключение; остальное — отказ или сбой на стороне сервера
      state.problem = error instanceof Error ? error.message : 'FAILED';
      calc.out = { answer: '' };
      log.warn(`нет связи с сервером расчётов: ${state.problem}`);
    }
  });
}
