/**
 * Тексты запроса разрешения на подключение: общие для окна Flux (ConnectionPrompt) и Studio (запуск программы),
 * чтобы разработчик видел ровно то, что спросят у человека, и расхождения между двумя окнами не копились.
 */
import { ACCESS_NAMES, type GrantAsk } from '../../../modules/connections/model';

const KIND_WORDS = { read: 'читать', write: 'изменять', send: 'отправлять данные' } as const;
export const promptTitle = (ask: GrantAsk) => `«${ask.moduleName}» хочет подключиться к ${ask.app}`;
export const PROMPT_LABEL = 'Запрос разрешения на подключение';
export const CHOICES = { never: 'Не разрешать', once: 'Только сейчас', always: 'Разрешить всегда' } as const;
export const MORE_OPEN = 'Подробнее';
export const MORE_CLOSE = 'Скрыть подробности';
export const TECH_LABEL = 'Для специалиста';
export const ALLOWED_TITLE = 'Разрешается:';
export const allowedText = (ask: GrantAsk) => `${KIND_WORDS[ask.access]} — в программе «${ask.app}».`;
export const NOT_GIVEN_TITLE = 'Программа не получит:';
export const NOT_GIVEN = ['права менять данные Flux — она их только читает;', 'доступа к файлам вашего компьютера;', 'других адресов и программ — они закрыты.'] as const;
export const AUTHOR_TITLE = 'Выпустил:';
export const authorText = (ask: GrantAsk) => {
  const verified = ask.verifiedAt ? new Date(ask.verifiedAt).toLocaleDateString('ru-RU') : '';
  return `${ask.author}${verified ? `; проверено владельцем ${verified}` : ''}. Версия ${ask.version}.`;
};
export const technicalText = (ask: GrantAsk) => `${ask.technical} · доступ: ${ACCESS_NAMES[ask.access]}`;
/** Где решение запоминается: во Flux — на компьютере и меняется в Store, в Studio — до закрытия окна */
export const REMEMBER_FLUX = 'Выбор «Разрешить всегда» или «Не разрешать» запомнится для этой программы на этом компьютере. Изменить его можно в Store, на странице программы.';
export const REMEMBER_STUDIO = 'Выбор «Разрешить всегда» или «Не разрешать» запомнится до закрытия Studio.';
