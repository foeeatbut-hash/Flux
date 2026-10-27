/**
 * Длинный серверный план для снимков панели плана импорта: как у владельца,
 * одна установка и три десятка новых позиций. Короткий план из фикстуры не
 * показывает ни прокрутку, ни закреплённую шапку, ни групповые действия.
 */
const KINDS: Array<[string, string, string]> = [
  ['Вентилятор', 'ВЕНТИЛЯТОР', 'FN'], ['Фильтр', 'ФИЛЬТР', 'FL'], ['Нагреватель', 'НАГРЕВАТЕЛЬ', 'HT'],
  ['Заслонка', 'КЛАПАН', 'DM'], ['Охладитель', 'ОХЛАДИТЕЛЬ', 'CL'], ['Датчик температуры', 'ДАТЧИК', 'TE'],
];

export function buildBigPlan(unit: string, rows: number) {
  const blocks: any[] = [];
  const tagLinks: any[] = [{ blockKey: `${unit}‖‖__unit__`, identifier: unit, action: 'create' }];
  for (let i = 0; i < rows; i++) {
    const [title, equipType, code] = KINDS[i % KINDS.length];
    const mono = `Моноблок ${Math.floor(i / 8) + 1}`;
    const identifier = `${unit.replace(/-\d+[A-Z]?$/u, '')}-${code}-${String(i + 1).padStart(3, '0')}A`;
    const key = `${unit}‖${mono}‖${code}${i + 1}`;
    blocks.push({ key, systemName: unit, monoblockName: mono, itemCode: `${code}${i + 1}`, title: `${title} ${i + 1}`, equipType, action: i === 5 ? 'update' : 'create',
      params: [{ group: 'Основные', key: 'Расход', value: String(1000 + i), unit: 'м³/ч', status: 'new' }], changedCount: 1, newCount: 1, overrideImpact: 0 });
    // Часть тегов уже есть в проекте (точное совпадение), часть похожа, два требуют решения
    const link: any = { blockKey: key, identifier, action: 'create' };
    if (i % 7 === 3) Object.assign(link, { action: 'link', existingTagId: `tag-existing-${i}` });
    else if (i % 11 === 4) Object.assign(link, { candidates: [{ id: `tag-like-${i}`, identifier: identifier.replace('-A', 'A'), why: 'другое написание' }] });
    else if (i === 9) Object.assign(link, { action: 'ambiguous', problem: 'в проекте несколько похожих тегов', candidates: [{ id: 'tag-x1', identifier: `${identifier}-1`, why: 'похожий' }, { id: 'tag-x2', identifier: `${identifier}-2`, why: 'похожий' }] });
    tagLinks.push(link);
  }
  return {
    systems: [{ name: unit, title: unit, action: 'create' }], blocks, tagLinks, matches: [], systemRows: [], missing: [],
    totals: { systems: 1, newBlocks: rows - 1, updatedBlocks: 1, unchangedBlocks: 0, overrides: 0 },
  };
}
