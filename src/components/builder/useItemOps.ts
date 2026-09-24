/**
 * Действия над позициями ведомости — всё, что меняет несколько строк сразу.
 *
 * Каждое действие — один пакет на сервер: одно действие человека, одна отмена.
 * Правленое руками (`overrides`) повторный подбор не трогает — он и нужен для
 * строк, где подбор ошибся, а не для тех, что инженер уже довёл сам.
 */
import type { Catalog } from '../../../catalog/model';
import type { SelectionItemData } from '../../../catalog/selection';
import { describe } from '../../../catalog/describe';
import { matchDescription, type Learned } from '../../../catalog/match';
import { detectorsFor } from '../../../catalog/seed';
import { buildDesignation } from '../../../catalog/designation';
import { splitTagCell } from '../../../catalog/tags';
import { signatureOf, parseNum, foldCode, stripDecor } from '../../../catalog/text';
import { newItemId, nextSort } from '../../store/builderStore';
import { catalogService } from '../../services/catalogService';
import type { Accepted } from '../catalog/DescribeMatch';

type Apply = (title: string, upserts: Array<Partial<SelectionItemData>>, removeIds?: string[]) => Promise<SelectionItemData[]>;

function matchInfo(c: ReturnType<typeof matchDescription>[number], rest: ReturnType<typeof matchDescription>) {
  return {
    confidence: c.confidence, reasons: c.reasons,
    alternatives: rest.map((x) => ({ familyId: x.familyId, score: x.score, designation: x.designation })),
    questions: c.questions.map((q) => ({ param: q.param, label: q.label })),
  };
}

export function itemOps(catalog: Catalog, classId: string, items: SelectionItemData[], learned: Learned[], apply: Apply) {
  const cls = catalog.classes.find((c) => c.id === classId);
  const det = detectorsFor(cls?.code || 'valve');
  const byId = new Map(items.map((i) => [i.id, i]));
  const designationOf = (familyId: string | undefined, values: Record<string, string | number>) => {
    const f = familyId ? catalog.families.find((x) => x.id === familyId) : undefined;
    return f ? buildDesignation(f, values).text : '';
  };

  return {
    /** Подобрать заново по исходному тексту */
    rematch: async (ids: string[]) => {
      const up: SelectionItemData[] = [];
      for (const id of ids) {
        const it = byId.get(id);
        if (!it?.sourceText) continue;
        const ov = new Set(it.overrides || []);
        if (ov.has('familyId') || ov.has('values')) continue;
        const d = describe(it.sourceText, det, { tags: it.tags });
        const list = matchDescription(catalog, d, { classId, learned, limit: 3 });
        const top = list.find((c) => !c.rejected);
        if (!top) continue;
        up.push({ ...it, familyId: top.familyId, values: top.values, designation: it.designationManual ? it.designation : top.designation, match: matchInfo(top, list.slice(1)), status: 'matched' });
      }
      if (up.length) await apply(`Повторный подбор: ${up.length} поз.`, up);
      return { done: up.length, skipped: ids.length - up.length };
    },

    /** Каждый тег — отдельной строкой с тем же изделием */
    split: async (ids: string[]) => {
      const up: Array<Partial<SelectionItemData>> = [];
      let sort = nextSort(items);
      for (const id of ids) {
        const it = byId.get(id);
        if (!it || it.tags.length < 2) continue;
        const [first, ...rest] = it.tags;
        up.push({ ...it, tags: [first], qty: 1, overrides: [...new Set([...(it.overrides || []), 'tags', 'qty'])] });
        for (const t of rest) up.push({ ...it, id: newItemId(), tags: [t], qty: 1, sort: sort++, overrides: [...new Set([...(it.overrides || []), 'tags', 'qty'])] });
      }
      if (up.length) await apply(`Разбиение по тегам: ${ids.length} поз.`, up);
      return up.length;
    },

    /**
     * Объединить одинаковые: то же семейство и то же обозначение. Разные
     * изделия в одну строку не сливаются — это ровно та ошибка, ради которой
     * в бланк смотрят второй раз.
     */
    merge: async (ids: string[]) => {
      const groups = new Map<string, SelectionItemData[]>();
      for (const id of ids) {
        const it = byId.get(id);
        if (!it) continue;
        const des = it.designation || designationOf(it.familyId, it.values);
        const key = `${it.familyId}|${foldCode(stripDecor(des))}`;
        groups.set(key, [...(groups.get(key) || []), it]);
      }
      const up: SelectionItemData[] = [];
      const rm: string[] = [];
      for (const list of groups.values()) {
        if (list.length < 2) continue;
        const [head, ...rest] = list;
        up.push({ ...head, tags: [...new Set(list.flatMap((x) => x.tags))], qty: list.reduce((a, b) => a + b.qty, 0), overrides: [...new Set([...(head.overrides || []), 'tags', 'qty'])] });
        rm.push(...rest.map((x) => x.id));
      }
      if (up.length) await apply(`Объединение: ${rm.length + up.length} поз. → ${up.length}`, up, rm);
      return { merged: up.length, differing: [...groups.values()].filter((l) => l.length < 2).length };
    },

    remove: async (ids: string[]) => { await apply(`Удаление ${ids.length} поз.`, [], ids); },

    bulkSet: async (ids: string[], key: string, value: string) => {
      const up: SelectionItemData[] = [];
      for (const id of ids) {
        const it = byId.get(id);
        if (!it) continue;
        const values = { ...it.values, [key]: value };
        up.push({ ...it, values, designation: it.designationManual ? it.designation : designationOf(it.familyId, values), overrides: [...new Set([...(it.overrides || []), 'values'])] });
      }
      if (up.length) await apply(`Групповая правка «${key}»: ${up.length} поз.`, up);
    },

    /**
     * Вставка строк из Excel: в каждой строке ищется тег, количество (число в
     * отдельной ячейке) и описание (самая длинная ячейка). Строка без описания
     * и без тега пропускается.
     */
    paste: async (text: string) => {
      let sort = nextSort(items);
      const up: Array<Partial<SelectionItemData>> = [];
      for (const line of text.split(/\r?\n/)) {
        const cells = line.split('\t').map((c) => c.trim()).filter(Boolean);
        if (!cells.length) continue;
        const tags = cells.flatMap((c) => splitTagCell(c).tags);
        const qtyCell = cells.find((c) => /^\d{1,4}([.,]0+)?$/.test(c));
        const desc = [...cells].filter((c) => c !== qtyCell && !splitTagCell(c).tags.length).sort((a, b) => b.length - a.length)[0] || '';
        if (!desc && !tags.length) continue;
        const d = describe(desc, det, { tags });
        const list = desc ? matchDescription(catalog, d, { classId, learned, limit: 3 }) : [];
        const top = list.find((c) => !c.rejected);
        up.push({
          id: newItemId(), classId, tags, qty: (qtyCell ? parseNum(qtyCell) : null) || tags.length || 1, sourceText: desc,
          familyId: top?.familyId, values: top?.values || {}, designation: top?.designation || '',
          match: top ? matchInfo(top, list.slice(1)) : undefined, status: top ? 'matched' : 'draft', sort: sort++,
        });
      }
      if (up.length) await apply(`Вставка из буфера: ${up.length} поз.`, up);
      return up.length;
    },

    /** Кандидат подбора → новая позиция; поправленное человеком запоминается */
    accept: async (a: Accepted) => {
      const values = a.values;
      await apply(`Подбор: ${a.tags[0] || catalog.families.find((f) => f.id === a.familyId)?.code || ''}`.trim(), [{
        id: newItemId(), classId, tags: a.tags, qty: a.qty, sourceText: a.text, familyId: a.familyId, values,
        designation: designationOf(a.familyId, values),
        match: { confidence: a.corrected ? 1 : a.candidate.confidence, reasons: a.candidate.reasons },
        status: 'matched', sort: nextSort(items),
      }]);
      if (a.corrected && a.text.trim()) {
        catalogService.learn({ classId, signature: signatureOf(a.text), familyId: a.familyId, values }).catch(() => undefined);
      }
    },
  };
}

/** Ведомость в Excel как таблица — для сверки и переписки, не бланк */
export async function exportListXlsx(catalog: Catalog, items: SelectionItemData[], name: string): Promise<Uint8Array> {
  const XLSX: any = await import('xlsx');
  const fam = new Map(catalog.families.map((f) => [f.id, f]));
  const rows = [['№', 'Теги', 'Кол-во', 'Семейство', 'Обозначение', 'Ширина', 'Высота', 'Диаметр', 'Уверенность', 'Статус', 'Источник', 'Примечание']];
  items.forEach((it, i) => {
    const f = it.familyId ? fam.get(it.familyId) : undefined;
    rows.push([
      String(i + 1), it.tags.join(', '), String(it.qty), f?.code || '', it.designation || (f ? buildDesignation(f, it.values).text : ''),
      String(it.values.W ?? ''), String(it.values.H ?? ''), String(it.values.D ?? ''),
      it.match ? `${Math.round(it.match.confidence * 100)}%` : '', it.status, it.sourceText || '', it.notes || '',
    ]);
  });
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [6, 28, 8, 14, 52, 9, 9, 9, 11, 11, 60, 30].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31) || 'Ведомость');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}
