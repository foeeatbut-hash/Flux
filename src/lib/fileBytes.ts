/**
 * Байты файла Проводника — одно место на всю программу.
 *
 * Раньше каждый читатель разбирал строку `data:…;base64,…` по-своему:
 * открытие офисного файла, выгрузка в Windows, предпросмотр, резервная копия.
 * Четыре одинаковых куска кода, которые обязаны были совпадать, — и один из
 * них однажды разошёлся бы.
 *
 * Теперь содержимое едет с сервера потоком (`/api/files/:id/raw`): он собирает
 * его из кусков и отдаёт как есть, без конверта JSON и без base64. Файлы
 * прежних версий, у которых содержимое лежит строкой, тот же маршрут отдаёт
 * так же — читателю разница не видна.
 */

/** Содержимое файла байтами. Пустой файл — пустой массив, а не ошибка */
export async function fileBytes(fileId: string): Promise<ArrayBuffer> {
  const res = await fetch(`/api/files/${encodeURIComponent(fileId)}/raw`);
  if (!res.ok) {
    throw new Error(res.status === 404
      ? 'Файл не найден: возможно, его удалили'
      : `Файл не прочитан: сервер ответил ${res.status}`);
  }
  return res.arrayBuffer();
}

/**
 * То же, но строкой data-URL — для тех, кому нужен готовый `src`: картинка в
 * предпросмотре, страница ПДФ во встроенном просмотрщике.
 */
export async function fileDataUrl(fileId: string, mime = 'application/octet-stream'): Promise<string> {
  const buf = await fileBytes(fileId);
  const bytes = new Uint8Array(buf);
  // По кускам, а не одной строкой: у String.fromCharCode есть предел числа
  // доводов, и на файле в несколько мегабайт вызов просто падает
  let bin = '';
  const STEP = 32 * 1024;
  for (let i = 0; i < bytes.length; i += STEP) {
    bin += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

/** Текст файла. Кодировка одна — UTF-8: иначе кириллица бьётся */
export async function fileText(fileId: string): Promise<string> {
  return new TextDecoder('utf-8').decode(await fileBytes(fileId));
}
