/** Поток ChaCha20 для скрытой колоды. Ключ приходит только от сервера. */
const ROT = (x: number, n: number) => (x << n) | (x >>> (32 - n));
const quarter = (w: number[], a: number, b: number, c: number, d: number) => {
  w[a] = (w[a] + w[b]) >>> 0; w[d] = ROT(w[d] ^ w[a], 16);
  w[c] = (w[c] + w[d]) >>> 0; w[b] = ROT(w[b] ^ w[c], 12);
  w[a] = (w[a] + w[b]) >>> 0; w[d] = ROT(w[d] ^ w[a], 8);
  w[c] = (w[c] + w[d]) >>> 0; w[b] = ROT(w[b] ^ w[c], 7);
};
const read32 = (b: Uint8Array, i: number) =>
  (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

/** Блок по RFC 8439; экспорт нужен для независимого проверочного вектора. */
export function chachaBlock(key: Uint8Array, counter: number, nonce = new Uint8Array(12)): Uint8Array {
  if (key.length !== 32 || nonce.length !== 12) throw new Error('Неверный ключ колоды');
  const initial = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];
  for (let i = 0; i < 32; i += 4) initial.push(read32(key, i));
  initial.push(counter >>> 0);
  for (let i = 0; i < 12; i += 4) initial.push(read32(nonce, i));
  const w = [...initial];
  for (let i = 0; i < 10; i++) {
    quarter(w, 0, 4, 8, 12); quarter(w, 1, 5, 9, 13);
    quarter(w, 2, 6, 10, 14); quarter(w, 3, 7, 11, 15);
    quarter(w, 0, 5, 10, 15); quarter(w, 1, 6, 11, 12);
    quarter(w, 2, 7, 8, 13); quarter(w, 3, 4, 9, 14);
  }
  const out = new Uint8Array(64);
  for (let i = 0; i < 16; i++) {
    const value = (w[i] + initial[i]) >>> 0;
    for (let j = 0; j < 4; j++) out[4 * i + j] = (value >>> (8 * j)) & 255;
  }
  return out;
}

export function secureDeck(seed: string): number[] {
  if (!/^[\da-f]{64}$/i.test(seed)) throw new Error('Семя колоды должно быть 32 байтами');
  const key = Uint8Array.from(seed.match(/../g)!, byte => parseInt(byte, 16));
  const cards = Array.from({ length: 52 }, (_, i) => i);
  let block = new Uint8Array(0);
  let offset = 64;
  let counter = 0;
  const next32 = () => {
    if (offset >= 64) { block = chachaBlock(key, counter++); offset = 0; }
    const value = read32(block, offset);
    offset += 4;
    return value;
  };
  for (let i = cards.length - 1; i > 0; i--) {
    const size = i + 1;
    const limit = Math.floor(0x100000000 / size) * size;
    let value: number;
    do { value = next32(); } while (value >= limit);
    const j = value % size;
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}
