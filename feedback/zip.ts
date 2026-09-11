/**
 * Сборка zip-архива.
 *
 * Лежит в общей папке, а не в `src/lib`, по одной причине: архив теперь
 * собирают двое — окно (выгрузка .docx) и сервер (пакет диагностики для
 * разработчика). Две копии одного формата разъехались бы в первый же месяц, а
 * разъехавшийся zip — это архив, который открывается у одного и не открывается
 * у другого. Прежнее место оставлено тонким реэкспортом, чтобы выгрузка Word
 * ничего не заметила.
 *
 * Нужна ради одного: настоящий файл Word. Выгрузка «в Word» отдавала HTML с
 * расширением .doc — Word такой файл открывает, но с предупреждением, и это не
 * документ Word, а страница, притворяющаяся им. Настоящий .docx — это zip с
 * несколькими XML внутри.
 *
 * Библиотеку ради этого не берём: zip — это заголовок, содержимое и оглавление
 * в конце, сотня строк. Сжатие необязательное: окну оно не нужно (документы
 * весят десятки килобайт), а сервер подаёт своё — `zlib.deflateRawSync`, — и
 * пакет диагностики из ста мегабайт JSONL ужимается на порядок. Лишняя
 * зависимость весит всегда, а эта не понадобилась ни разу.
 *
 * Проверяется скриптом (scripts/test-docx.ts): собранный архив читается тем же
 * разбором, которым программа читает чужие docx, — если бы байты разъехались,
 * это было бы видно только на чужой машине в Word.
 */

/** Таблица CRC32 — считается один раз, дальше используется на каждый файл */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** Путь внутри архива: «word/document.xml» */
  name: string;
  data: string | Uint8Array;
}

/**
 * Чем сжимать. Возвращает СЫРОЙ deflate — тот, что кладут в zip способом 8.
 *
 * Необязательный: без него архив хранит как есть, и это по-прежнему настоящий
 * zip. Окно ничего не подаёт, сервер подаёт `zlib.deflateRawSync`.
 */
export type Deflate = (data: Uint8Array) => Uint8Array;

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Небольшой писатель байтов: zip состоит из чисел, уложенных младшим байтом вперёд */
class Bytes {
  private parts: Uint8Array[] = [];
  private len = 0;

  push(chunk: Uint8Array): void { this.parts.push(chunk); this.len += chunk.length; }
  u16(n: number): void { this.push(new Uint8Array([n & 0xff, (n >>> 8) & 0xff])); }
  u32(n: number): void {
    this.push(new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]));
  }
  get length(): number { return this.len; }
  join(): Uint8Array {
    const out = new Uint8Array(this.len);
    let at = 0;
    for (const p of this.parts) { out.set(p, at); at += p.length; }
    return out;
  }
}

/**
 * Собрать архив. Время файлов — постоянное: два одинаковых документа должны
 * давать одинаковые байты, иначе их не сравнить ни глазом, ни проверкой.
 */
export function zip(entries: ZipEntry[], deflate?: Deflate): Uint8Array {
  const out = new Bytes();
  const central: { name: Uint8Array; crc: number; size: number; packed: number; at: number; method: number }[] = [];

  for (const entry of entries) {
    const name = utf8(entry.name);
    const data = typeof entry.data === 'string' ? utf8(entry.data) : entry.data;
    const at = out.length;
    // Сумма считается по ИСХОДНЫМ байтам и при сжатии тоже: так устроен zip,
    // и распаковщик сверяет именно её
    const sum = crc32(data);

    // Сжимаем только когда есть чем и когда от этого есть польза: на коротком
    // содержимом deflate иногда выходит длиннее исходного
    let body = data;
    let method = 0;
    if (deflate && data.length > 64) {
      try {
        const packed = deflate(data);
        if (packed.length < data.length) { body = packed; method = 8; }
      } catch (_) { /* не сжалось — кладём как есть, архив от этого не портится */ }
    }

    out.u32(0x04034b50);   // подпись локального заголовка
    out.u16(20);           // нужна версия 2.0
    out.u16(0x0800);       // имена в UTF-8
    out.u16(method);       // 0 — как есть, 8 — deflate
    out.u16(0); out.u16(0); // время и дата — постоянные
    out.u32(sum);
    out.u32(body.length);  // сжатый размер
    out.u32(data.length);  // и исходный
    out.u16(name.length);
    out.u16(0);            // дополнительных полей нет
    out.push(name);
    out.push(body);

    central.push({ name, crc: sum, size: data.length, packed: body.length, at, method });
  }

  const dirAt = out.length;
  for (const c of central) {
    out.u32(0x02014b50);   // подпись записи оглавления
    out.u16(20); out.u16(20);
    out.u16(0x0800);
    out.u16(c.method);
    out.u16(0); out.u16(0);
    out.u32(c.crc);
    out.u32(c.packed); out.u32(c.size);
    out.u16(c.name.length);
    out.u16(0); out.u16(0); out.u16(0); out.u16(0);
    out.u32(0);            // обычный файл, без особых прав
    out.u32(c.at);
    out.push(c.name);
  }
  const dirSize = out.length - dirAt;

  out.u32(0x06054b50);     // подпись конца архива
  out.u16(0); out.u16(0);
  out.u16(central.length); out.u16(central.length);
  out.u32(dirSize);
  out.u32(dirAt);
  out.u16(0);              // без примечания
  return out.join();
}
