/**
 * Родство тегов: кто у кого в родителях после импорта расчёта.
 *
 * Правило владельца проекта дословно: «самый главный тег — это тег установки.
 * Родительским тегом для вентилятора будет тег установки. Если в вентиляторе
 * есть двигатель, то для него родителем будет тег вентилятора. Если есть
 * позиция датчик ПТС в двигателе, то для него родителем будет тег двигателя, а
 * потом тег установки».
 *
 * Отсюда одно вычисление: родитель тега — тег БЛИЖАЙШЕГО ТЕГИРОВАННОГО ПРЕДКА
 * позиции, а если такого нет — тег установки. Промежуточная позиция без тега
 * не обрывает цепочку и не получает выдуманного тега: двигатель в
 * нетегированном вентиляторе просто поднимается к установке, и это видно
 * словами до записи.
 *
 * Пишется связь в существующее дерево тегов (`src/lib/tagTree.ts`,
 * `metadata.parentId` + `metadata.connections`), а не во вторую параллельную
 * структуру: раздел «Теги» рисует именно его, и второе дерево разошлось бы с
 * первым на первой же ручной правке.
 *
 * Модуль чистый: ни базы, ни сети. Проверяется `scripts/test-equipment-hierarchy.ts`.
 */

import { linkChild, parentOf, type TreeNode, type TreePatch } from '../src/lib/tagTree.js';

/** Позиция реестра глазами родства: где стоит и каким тегом помечена. */
export interface TaggedPosition {
  /** Ключ позиции — тот же, которым пользуются план импорта и запись */
  key: string;
  /** Ключ владельца; пусто — позиция верхнего уровня (блок) */
  parentKey?: string;
  /** Тег позиции; пусто — позиция без тега */
  tagId?: string;
  /** Как называть позицию человеку */
  title?: string;
}

export interface ParentDecision {
  childTagId: string;
  parentTagId: string;
  /** Словами: откуда взялся родитель */
  why: string;
  /** Применяется ли решение; false — родителя ставили рукой, и он сильнее */
  applied: boolean;
}

export interface HierarchyPlan {
  decisions: ParentDecision[];
  /** Что записать в metadata тегов */
  patches: TreePatch[];
}

/** Применить правки к рабочему списку узлов — чтобы следующий шаг видел их. */
function applyTo(nodes: TreeNode[], patches: TreePatch[]): TreeNode[] {
  const byId = new Map(nodes.map((n) => [n.id, { ...n }]));
  for (const p of patches) {
    const n = byId.get(p.id) || { id: p.id };
    n.connections = p.connections;
    n.parentId = p.parentId ?? null;
    byId.set(p.id, n);
  }
  return [...byId.values()];
}

/**
 * Родство тегов по составу оборудования.
 *
 * `handSet` — теги, родителя которых поставил человек. Их импорт не трогает:
 * инженер знает про свой объект больше, чем расчёт, и перебивать его решение
 * каждым повторным импортом — это заставить его делать одну работу дважды.
 * Расхождение при этом не прячется: оно попадает в `decisions` с `applied:
 * false` и объяснением.
 */
export function planTagParents(
  positions: TaggedPosition[],
  unitTagId: string,
  nodes: TreeNode[],
  handSet: Set<string> = new Set(),
): HierarchyPlan {
  const byKey = new Map(positions.map((p) => [p.key, p]));
  const decisions: ParentDecision[] = [];
  let work = nodes.map((n) => ({ ...n }));
  const patches: TreePatch[] = [];

  /** Ближайший тегированный предок позиции, вместе с путём для объяснения. */
  const ancestorTag = (p: TaggedPosition): { tagId: string; via: string } => {
    const seen = new Set<string>([p.key]);
    let at = p.parentKey ? byKey.get(p.parentKey) : undefined;
    while (at && !seen.has(at.key)) {
      seen.add(at.key);
      if (at.tagId && at.tagId !== p.tagId) return { tagId: at.tagId, via: at.title || at.key };
      at = at.parentKey ? byKey.get(at.parentKey) : undefined;
    }
    return { tagId: '', via: '' };
  };

  for (const p of positions) {
    if (!p.tagId || p.tagId === unitTagId) continue;

    const up = ancestorTag(p);
    const parentTagId = up.tagId || unitTagId;
    if (!parentTagId || parentTagId === p.tagId) continue;

    const why = up.tagId
      ? `Родитель — тег позиции «${up.via}»: она владеет этой позицией по составу`
      : 'Тегированного владельца нет — родителем становится тег установки';

    if (handSet.has(p.tagId)) {
      const now = parentOf(work, p.tagId);
      decisions.push({
        childTagId: p.tagId, parentTagId, applied: false,
        why: now === parentTagId
          ? 'Родитель уже стоит так же — менять нечего'
          : 'Родителя назначили вручную: ручное решение сильнее расчёта, связь оставлена как есть',
      });
      continue;
    }

    if (parentOf(work, p.tagId) === parentTagId) continue; // уже так и есть

    const made = linkChild(work, parentTagId, p.tagId);
    if (!made.length) {
      // `linkChild` молча отказывает на кольце и на несуществующем теге —
      // молчать вслед за ним нельзя, иначе связь просто не появится
      decisions.push({
        childTagId: p.tagId, parentTagId, applied: false,
        why: 'Связь не построена: получилось бы кольцо или тега нет в проекте',
      });
      continue;
    }
    work = applyTo(work, made);
    patches.push(...made);
    decisions.push({ childTagId: p.tagId, parentTagId, why, applied: true });
  }

  // Правок на один тег могло накопиться несколько (его двигали по дереву) —
  // в базу уходит последнее состояние, а не вся история движений
  const last = new Map<string, TreePatch>();
  for (const p of patches) last.set(p.id, p);
  return { decisions, patches: [...last.values()] };
}

/**
 * Родителя поставили рукой?
 *
 * Отметка живёт в metadata тега рядом с самой связью: `parentBy: 'hand'`.
 * Отсутствие отметки читается как «поставил импорт» — так ведут себя все
 * связи, заведённые до появления этого поля, и переспрашивать про них человека
 * не за что.
 */
export function parentSetByHand(metadata: unknown): boolean {
  const src: any = typeof metadata === 'string' ? safeJson(metadata) : metadata;
  return !!src && typeof src === 'object' && src.parentBy === 'hand';
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch (_) { return null; }
}
