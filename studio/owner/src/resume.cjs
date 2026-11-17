'use strict';
/**
 * Вход без вопросов: открыть хранилище запомненным паролем и подключиться к запомненной базе.
 *
 * Срок пароля не продлевается: сутки считаются от того ввода, который сделал человек (remember.cjs), а не
 * от каждого автоматического открытия — иначе «раз в сутки» превратилось бы в «никогда».
 * Каждый шаг самостоятелен: открылось хранилище, но база не ответила — человек остаётся в открытом
 * хранилище и видит причину рядом с формой подключения, а не пустой экран.
 */
async function resumeSession({ remember, unlocked, connected, unlock, connect, log = () => {} }) {
  const result = { unlocked: unlocked(), connected: connected(), error: '' };
  if (!result.unlocked) {
    const password = remember.password();
    if (!password) return result;
    try {
      await unlock(password);
      result.unlocked = true;
    } catch (error) {
      // Пароль, который больше не подходит, хранить незачем: следующий вход спросит новый
      remember.forgetPassword();
      log('resume.unlock.failure', error);
      result.error = 'Сохранённый пароль не открыл хранилище. Введите пароль.';
      return result;
    }
  }
  if (!result.connected) {
    const server = remember.server();
    if (server) {
      try {
        await connect(server.uri);
        result.connected = true;
      } catch (error) {
        log('resume.connect.failure', error);
        result.error = `Не удалось подключиться по сохранённому адресу${server.display ? ` (${server.display})` : ''}: ${String(error?.message || error).slice(0, 300)}`;
      }
    }
  }
  return result;
}

module.exports = { resumeSession };
