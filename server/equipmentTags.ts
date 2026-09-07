// ── Теги бланка: найти, привязать, создать ───────────────────────────────────
// В бланке технологическая позиция (тег) — адрес изделия в проекте, а не его
// название. Раньше найденный код превращался в текст «Название»/«Система» и
// связь с реестром тегов не возникала никогда: importEquipmentToDB не обращался
// к таблице тегов вовсе.
//
// Здесь три вещи: приведение написаний к одному виду, разбор «что делать с
// каждым тегом» до записи (для предпросмотра) и применение решений инженера.
// Молча тег не создаётся и не перевешивается: решение принимает человек.

export interface TagCandidate { id: string; identifier: string; why: string }

export interface TagLink {
  /** blockKey позиции, к которой относится тег */
  blockKey: string;
  /** Код так, как он написан в бланке */
  identifier: string;
  /** Что предлагается сделать; инженер может поменять в предпросмотре */
  action: 'link' | 'create' | 'skip';
  /** Точное совпадение в проекте */
  existingTagId?: string;
  /** Тег занят другим изделием — «один тег — одно изделие» */
  takenBy?: string;
  /** Похожие теги проекта: другой регистр, латиница/кириллица, дефисы */
  candidates?: TagCandidate[];
}

/**
 * Написание тега к сравнимому виду: регистр, пробелы, разные дефисы и
 * кириллические двойники латинских букв. «3700-C01-BL-001Е» (с кириллической Е)
 * и «3700-c01-bl-001e» — один и тот же тег: в бланках это встречается
 * постоянно, потому что часть кода набирают в русской раскладке.
 */
const LOOKALIKE: Record<string, string> = {
  а: 'a', в: 'b', с: 'c', е: 'e', н: 'h', к: 'k', м: 'm', о: 'o', р: 'p', т: 't', х: 'x', у: 'y',
};
export function normalizeTag(raw: string): string {
  const s = String(raw ?? '').toLowerCase()
    .replace(/[\s ‐-―]/g, m => (/\s| /.test(m) ? '' : '-'))
    .replace(/[_.]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return [...s].map(ch => LOOKALIKE[ch] ?? ch).join('');
}

export interface ExistingTag { id: string; identifier: string; componentIds?: string[] }

/** Похожесть без учёта разделителей вовсе: «3700C01BL001E» */
const bare = (s: string) => normalizeTag(s).replace(/-/g, '');

/**
 * Что делать с каждым тегом бланка. Ничего не пишет — только раскладывает
 * решения, которые инженер увидит в предпросмотре.
 */
export function planTagLinks(
  blocks: { key: string; tags?: string[] }[],
  existing: ExistingTag[],
): TagLink[] {
  const byNorm = new Map<string, ExistingTag>();
  const byBare = new Map<string, ExistingTag[]>();
  for (const t of existing) {
    const n = normalizeTag(t.identifier);
    if (!byNorm.has(n)) byNorm.set(n, t);
    const b = bare(t.identifier);
    (byBare.get(b) ?? byBare.set(b, []).get(b)!).push(t);
  }

  const out: TagLink[] = [];
  const seen = new Set<string>();
  for (const blk of blocks) {
    for (const raw of blk.tags || []) {
      const identifier = String(raw || '').trim();
      if (!identifier) continue;
      const key = `${blk.key}‖${identifier}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const hit = byNorm.get(normalizeTag(identifier));
      if (hit) {
        const takenBy = (hit.componentIds || []).length ? (hit.componentIds || [])[0] : undefined;
        out.push({ blockKey: blk.key, identifier, action: 'link', existingTagId: hit.id, takenBy });
        continue;
      }
      // Похожие: те же знаки без разделителей — обычно опечатка в дефисах
      const near = (byBare.get(bare(identifier)) || []).slice(0, 5)
        .map(t => ({ id: t.id, identifier: t.identifier, why: 'то же обозначение, другие разделители' }));
      out.push({
        blockKey: blk.key, identifier,
        action: near.length ? 'link' : 'create',
        ...(near.length ? { existingTagId: near[0].id, candidates: near } : {}),
      });
    }
  }
  return out;
}

export interface TagApplyResult { linked: number; created: number; skipped: number; conflicts: string[] }

/**
 * Применяет решения инженера: привязывает существующие теги, заводит новые,
 * пропускает отказы. Правило «один тег — одно изделие» соблюдается: занятый
 * тег не перевешивается молча, а возвращается сообщением.
 */
export async function applyTagLinks(
  prisma: any,
  projectId: string,
  links: TagLink[],
  componentIdByKey: Map<string, string>,
): Promise<TagApplyResult> {
  const res: TagApplyResult = { linked: 0, created: 0, skipped: 0, conflicts: [] };
  for (const link of links) {
    const componentId = componentIdByKey.get(link.blockKey);
    if (!componentId || link.action === 'skip') { res.skipped++; continue; }

    let tagId = link.existingTagId;
    if (link.action === 'create' || !tagId) {
      const created = await prisma.tag.create({ data: { identifier: link.identifier, projectId } });
      tagId = created.id;
      res.created++;
    }

    const tag = await prisma.tag.findUnique({
      where: { id: tagId },
      include: { componentElements: { select: { id: true, name: true, itemCode: true } } },
    });
    if (!tag) { res.skipped++; continue; }
    const takenBy = (tag.componentElements || []).find((c: any) => c.id !== componentId);
    if (takenBy) {
      res.conflicts.push(`«${tag.identifier}» уже привязан к «${takenBy.name || takenBy.itemCode}» — оставлен как был`);
      continue;
    }
    await prisma.componentElement.update({
      where: { id: componentId },
      data: { tags: { connect: { id: tagId } } },
    });
    res.linked++;
  }
  return res;
}
