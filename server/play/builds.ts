/**
 * Что опубликовано: сборки игр и ключ издателя.
 *
 * Сервер здесь ничего не проверяет и не подписывает — он отдаёт. Подпись
 * ставит издатель своим ключом (тем же способом, что и лицензию: подписывающий
 * ключ живёт у владельца и в программу не попадает), а сверяет её оболочка на
 * машине сотрудника. Сервер в этой цепочке — почтальон, и доверять ему больше,
 * чем почтальону, не нужно: подменивший файл на сервере подписи не подделает.
 *
 * Публикация сборок (каналы, выкладка, отзыв) — отдельная работа
 * администратора; здесь только чтение, потому что менеджеру игр на машине
 * сотрудника нужно знать ровно одно: какая версия считается нынешней и чем
 * она описана.
 */

import { getPrisma } from '../context.js';
import { parseManifest, type BuildManifest } from '../../play/builds.js';

/** Канал по умолчанию: обычный сотрудник сидит на нём и не выбирает */
export const DEFAULT_CHANNEL = 'stable';

/** Ключ издателя в настройках. Здесь ОТКРЫТАЯ часть — подписывающей у нас нет */
export const PUBLISHER_KEY_SETTING = 'play.publisher.key';

export interface PublishedBuild {
  gameId: string;
  channel: string;
  version: string;
  /** Адрес сборки: от него менеджер разрешает адреса файлов описи */
  url: string;
  sizeBytes: number;
  publishedAt: number;
  manifest: BuildManifest;
}

/**
 * Последняя опубликованная сборка канала.
 *
 * `null` — это не поломка, а «публиковать нечего»: так и выглядит платформа до
 * первой выкладки. Кнопка в окне скажет об этом прямо, а не пообещает
 * установку, которой неоткуда взяться.
 */
export async function latestBuild(gameId: string, channel = DEFAULT_CHANNEL): Promise<PublishedBuild | null> {
  const prisma = getPrisma();
  const row = await prisma.playBuild.findFirst({
    where: { gameId, channel },
    orderBy: { publishedAt: 'desc' },
  });
  if (!row) return null;

  // Опись, которую нельзя разобрать, — это отсутствие сборки, а не сборка с
  // оговоркой: ставить по ней нечего, и делать вид, что есть, нельзя
  const parsed = parseManifest(row.manifestJson);
  if (!parsed.manifest) return null;

  return {
    gameId: row.gameId,
    channel: row.channel,
    version: row.version,
    url: row.url,
    sizeBytes: Number(row.sizeBytes) || 0,
    publishedAt: new Date(row.publishedAt).getTime(),
    manifest: parsed.manifest,
  };
}

/** Открытый ключ издателя сборок; пусто — ключ ещё не заведён. */
export async function publisherKey(): Promise<string> {
  try {
    const prisma = getPrisma();
    const row = await prisma.appSetting.findFirst({ where: { key: PUBLISHER_KEY_SETTING, userId: null } });
    const value = String(row?.value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(value) ? value : '';
  } catch (_) {
    // Настройки нет — ключа нет. Это не поломка: до первой выкладки его и
    // неоткуда взять, а установка без ключа всё равно не состоится
    return '';
  }
}
