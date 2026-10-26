import path from 'path';

/**
 * Где на диске лежит скачанное вложение письма.
 *
 * В имя файла входит id вложения. Раньше файл назывался просто по имени
 * вложения, и два вложения одного письма с одинаковым именем («image.png» у
 * двух картинок в подписи, «Скан.pdf» дважды) писались в один файл: второе
 * затирало первое, и обе строки вложений скачивали одно и то же.
 */
export function attachmentFile(
  base: string, accountId: string, messageId: string, attachmentId: string, fileName: string,
): string {
  const safe = String(fileName || 'файл').replace(/[\\/:*?"<>|]/g, '_') || 'файл';
  return path.join(base, 'mail_files', accountId, messageId, `${attachmentId}_${safe}`);
}
