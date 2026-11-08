/** SQLite ограничивает число параметров запроса; размер проекта при этом не ограничивается. */
export async function readInBatches<T>(values: string[], read: (part: string[]) => Promise<T[]>): Promise<T[]> {
  const unique = [...new Set(values)];
  const result: T[] = [];
  for (let offset = 0; offset < unique.length; offset += 400) {
    for (const row of await read(unique.slice(offset, offset + 400))) result.push(row);
  }
  return result;
}
