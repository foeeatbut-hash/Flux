// ── Теги бланка: найти, привязать, создать ───────────────────────────────────
// В бланке технологическая позиция (тег) — адрес изделия в проекте, а не его
// название. Раньше найденный код превращался в текст «Название»/«Система» и
// связь с реестром тегов не возникала никогда: importEquipmentToDB не обращался
// к таблице тегов вовсе.
//
// Здесь три вещи: приведение написаний к одному виду, разбор «что делать с
// каждым тегом» до записи (для предпросмотра) и применение решений инженера.
// Молча тег не создаётся и не перевешивается: решение принимает человек.

import {
  DEFAULT_TAG_POLICY, identityKeyOf, similarityKeyOf, validateTag, type TagPolicy,
} from '../equipment/tagPolicy.js';

export interface TagCandidate { id: string; identifier: string; why: string }

export interface TagLink {
  /** blockKey позиции, к которой относится тег */
  blockKey: string;
  /** Код так, как он написан в бланке */
  identifier: string;
  /**
   * Что предлагается сделать; инженер может поменять в предпросмотре.
   *
   * `ambiguous` — не отказ, а честное «выберите»: в проекте есть несколько
   * записей, которые после приведения написаний неотличимы. Раньше в этом
   * месте молча брался первый, и предложение выглядело как единственное
   * точное совпадение.
   */
  action: 'link' | 'create' | 'skip' | 'ambiguous' | 'invalid';
  /** Почему запись невозможна — для состояния «Кириллица запрещена» */
  problem?: string;
  /** Предложенное исправление написания; применяет его человек, не программа */
  fix?: string;
  /** Точное совпадение в проекте */
  existingTagId?: string;
  /** Тег занят другим изделием — «один тег — одно изделие» */
  takenBy?: string;
  /** Похожие теги проекта: другой регистр, латиница/кириллица, дефисы */
  candidates?: TagCandidate[];
}

/**
 * Написание к сравнимому виду — ТОЛЬКО для подсказки «похоже на…».
 *
 * Раньше эта же функция решала, один ли это тег, и потому подменяла
 * кириллические буквы латинскими. Из-за этого запрет кириллицы был невыполним:
 * «В» становилась «B» раньше любой проверки. Теперь идентичность считает
 * `equipment/tagPolicy.ts` и алфавит не трогает, а здесь остаётся похожесть.
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
const bare = (s: string) => similarityKeyOf(s);

/**
 * Что делать с каждым тегом бланка. Ничего не пишет — только раскладывает
 * решения, которые инженер увидит в предпросмотре.
 */
export function planTagLinks(
  blocks: { key: string; tags?: string[] }[],
  existing: ExistingTag[],
  policy: TagPolicy = DEFAULT_TAG_POLICY,
): TagLink[] {
  // Собираем ВСЕХ, кто сходится после приведения, а не первого. «AB-01» и
  // «AB_01» дают один нормализованный вид, и выбирать между ними за инженера
  // нельзя: это могут быть разные позиции с разными изделиями
  const byNorm = new Map<string, ExistingTag[]>();
  const byBare = new Map<string, ExistingTag[]>();
  for (const t of existing) {
    const n = identityKeyOf(t.identifier);
    (byNorm.get(n) ?? byNorm.set(n, []).get(n)!).push(t);
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

      /**
       * Сначала проверка правил проекта, и только потом поиск совпадений.
       * Запрещённое написание не ищется в реестре вовсе: найденное «похожее»
       * выглядело бы как разрешение записать то, что записывать нельзя.
       */
      const check = validateTag(identifier, policy);
      if (!check.ok) {
        out.push({
          blockKey: blk.key, identifier, action: 'invalid',
          problem: check.problem, ...(check.fix ? { fix: check.fix } : {}),
        });
        continue;
      }

      const hits = byNorm.get(identityKeyOf(identifier)) || [];

      // Точное совпадение, буква в букву, — единственный случай, когда решать
      // за инженера можно: это тот же самый тег
      const exact = hits.filter(t => t.identifier === identifier);
      if (exact.length === 1) {
        const takenBy = (exact[0].componentIds || [])[0];
        out.push({ blockKey: blk.key, identifier, action: 'link', existingTagId: exact[0].id, takenBy });
        continue;
      }

      if (hits.length === 1) {
        const takenBy = (hits[0].componentIds || [])[0];
        out.push({ blockKey: blk.key, identifier, action: 'link', existingTagId: hits[0].id, takenBy });
        continue;
      }
      if (hits.length > 1) {
        out.push({
          blockKey: blk.key, identifier, action: 'ambiguous',
          candidates: hits.slice(0, 5).map(t => ({
            id: t.id, identifier: t.identifier,
            why: 'после приведения написаний совпадает с этим тегом',
          })),
        });
        continue;
      }

      // Похожие: те же знаки без разделителей — обычно опечатка в дефисах
      const near = (byBare.get(bare(identifier)) || []).slice(0, 5)
        .map(t => ({ id: t.id, identifier: t.identifier, why: 'то же обозначение, другие разделители' }));
      if (near.length > 1) {
        out.push({ blockKey: blk.key, identifier, action: 'ambiguous', candidates: near });
        continue;
      }
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
  policy: TagPolicy = DEFAULT_TAG_POLICY,
): Promise<TagApplyResult> {
  const res: TagApplyResult = { linked: 0, created: 0, skipped: 0, conflicts: [] };
  for (const link of links) {
    const componentId = componentIdByKey.get(link.blockKey);
    if (!componentId || link.action === 'skip') { res.skipped++; continue; }

    // Правила проекта проверяются ЗДЕСЬ ещё раз, а не только в предпросмотре:
    // между предпросмотром и записью политику могли поменять, а запрос мог
    // прийти и мимо окна
    const check = validateTag(link.identifier, policy);
    if (!check.ok) {
      res.skipped++;
      res.conflicts.push(`«${link.identifier}»: ${check.problem}`);
      continue;
    }
    // Неоднозначное решение инженер не принял — писать нечего. Взять первого
    // кандидата здесь значило бы обойти собственную защиту
    if (link.action === 'ambiguous' && !link.existingTagId) {
      res.skipped++;
      res.conflicts.push(`«${link.identifier}» совпадает с несколькими тегами проекта — выберите нужный`);
      continue;
    }

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
    /**
     * Тег обязан принадлежать ЭТОМУ проекту.
     *
     * Идентификатор существующего тега приходит снаружи, и без этой проверки
     * подстановка чужого id привязывала бы оборудование одного проекта к тегу
     * другого. Реестр тегов после такого не чинится ничем, кроме рук.
     */
    if (tag.projectId !== projectId) {
      res.skipped++;
      res.conflicts.push(`«${link.identifier}» принадлежит другому проекту — привязка не сделана`);
      continue;
    }
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
