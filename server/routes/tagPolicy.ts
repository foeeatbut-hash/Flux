/**
 * Политика тегов проекта: чтение, изменение и проверка на примере.
 *
 * Правило одно на всю программу и лежит в общем модуле
 * (`equipment/tagPolicy.ts`). Здесь только хранение и маршруты — иначе у
 * сервера завелась бы вторая реализация тех же правил, и окно принимало бы
 * тег, который сервер отвергает.
 *
 * Хранение — отдельной таблицей, а не полем проекта: у политики своя версия,
 * и план импорта её запоминает. Поле в `Project` пришлось бы добавлять во все
 * три схемы Prisma ради двух значений, а версию всё равно хранить отдельно.
 */

import type { Express, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { getPrisma, onDatabaseSwapped } from '../context.js';
import { ensureTables, type TableSpec } from '../ddl.js';
import {
  DEFAULT_TAG_POLICY, extractCandidates, tagPolicyOf, validateTag, type TagPolicy,
} from '../../equipment/tagPolicy.js';

const TABLES: TableSpec[] = [{
  table: 'ProjectTagPolicy',
  cols: [
    { name: 'id', kind: 'text', pk: true, indexed: true },
    { name: 'projectId', kind: 'text', notNull: true, def: '', indexed: true },
    { name: 'policyJson', kind: 'longtext', def: '{}' },
    { name: 'version', kind: 'int', notNull: true, def: 1 },
    { name: 'updatedById', kind: 'text', indexed: true },
    { name: 'updatedAt', kind: 'time', notNull: true, def: 'now' },
  ],
  // Одна политика на проект: вторая означала бы, что часть импорта живёт по
  // одним правилам, а часть по другим
  indexes: [{ name: 'ProjectTagPolicy_project_key', cols: ['projectId'], unique: true }],
}];

let ready = false;
onDatabaseSwapped(() => { ready = false; });

async function ensure(): Promise<void> {
  if (ready) return;
  const why = await ensureTables(getPrisma(), TABLES, (m) => console.error('[Теги]', m));
  if (why) throw new Error(why);
  ready = true;
}

/**
 * Политика проекта. Нет записи — значит запрет кириллицы и пустые приставки:
 * умолчание здесь запрет, а не «как-нибудь разберёмся».
 */
export async function policyOfProject(projectId: string): Promise<TagPolicy> {
  if (!projectId) return { ...DEFAULT_TAG_POLICY };
  try {
    await ensure();
    const row = await getPrisma().projectTagPolicy.findFirst({ where: { projectId } });
    if (!row) return { ...DEFAULT_TAG_POLICY };
    return { ...tagPolicyOf(row.policyJson), version: Number(row.version) || 1 };
  } catch (_) {
    // Таблицы ещё нет или база недоступна — работаем по умолчанию, а не падаем
    return { ...DEFAULT_TAG_POLICY };
  }
}

/**
 * Правило для ввоза: то же, что у проекта, плюс код проекта приставкой.
 *
 * Код проекта заводят в его параметрах («3700»), а приставки политики — в
 * отдельном экране, до которого доходят не все. Владелец описал правило так:
 * «тег начинается с кода проекта» — значит, код и есть приставка, пока
 * человек не задал других. В сохранённую политику это НЕ пишется: экран
 * правил показывает то, что задано руками, а не то, что подставлено.
 */
export async function importPolicyOfProject(projectId: string): Promise<TagPolicy> {
  const policy = await policyOfProject(projectId);
  if (policy.prefixes.length || !projectId) return policy;
  try {
    const project = await getPrisma().project.findUnique({ where: { id: projectId }, select: { code: true } });
    const code = String(project?.code || '').trim();
    return code ? { ...policy, prefixes: [code] } : policy;
  } catch (_) {
    return policy;
  }
}

/** Сколько существующих тегов проекта не проходит по нынешним правилам. */
export async function mismatchCount(projectId: string, policy: TagPolicy): Promise<number> {
  try {
    const tags = await getPrisma().tag.findMany({ where: { projectId }, select: { identifier: true }, take: 5000 });
    return tags.filter((t: any) => !validateTag(t.identifier, policy).ok).length;
  } catch (_) { return 0; }
}

export function registerTagPolicyRoutes(app: Express): void {
  app.get('/api/projects/:id/tag-policy', async (req: Request, res: Response) => {
    const projectId = String(req.params.id || '');
    try {
      const policy = await policyOfProject(projectId);
      res.json({ policy, mismatched: await mismatchCount(projectId, policy) });
    } catch (e: any) {
      res.status(500).json({ error: 'Не удалось прочитать правила тегов', details: e?.message });
    }
  });

  /**
   * Изменение правил.
   *
   * Отключение кириллицы существующие теги НЕ трогает: они остаются
   * читаемыми, их связи целы, и об их числе честно сказано в ответе. Чинят их
   * явным переименованием, а не молчаливой заменой букв при сохранении правил.
   */
  app.put('/api/projects/:id/tag-policy', async (req: Request, res: Response) => {
    const projectId = String(req.params.id || '');
    if (!projectId) return res.status(400).json({ error: 'Не указан проект' });
    try {
      await ensure();
      const prisma = getPrisma();
      const was = await prisma.projectTagPolicy.findFirst({ where: { projectId } });
      const next = tagPolicyOf(req.body?.policy);
      const version = (Number(was?.version) || 0) + 1;
      const data = {
        projectId,
        policyJson: JSON.stringify({ ...next, version }),
        version,
        updatedById: String((req as any).authUser?.id || '') || null,
        updatedAt: new Date(),
      };
      if (was) await prisma.projectTagPolicy.update({ where: { id: was.id }, data });
      else await prisma.projectTagPolicy.create({ data: { id: randomUUID(), ...data } });

      const policy = await policyOfProject(projectId);
      return res.json({ policy, mismatched: await mismatchCount(projectId, policy) });
    } catch (e: any) {
      return res.status(500).json({ error: 'Не удалось сохранить правила тегов', details: e?.message });
    }
  });

  /**
   * Проверка на примере — ничего не пишет.
   *
   * Человеку нужно видеть, что программа найдёт в его тексте, ДО того как он
   * запустит импорт на двадцати трёх файлах.
   */
  app.post('/api/projects/:id/tag-policy/preview', async (req: Request, res: Response) => {
    const projectId = String(req.params.id || '');
    try {
      const policy = req.body?.policy ? tagPolicyOf(req.body.policy) : await policyOfProject(projectId);
      const text = String(req.body?.text || '');
      const registry = await getPrisma().tag.findMany({
        where: { projectId }, select: { identifier: true }, take: 2000,
      }).then((rows: any[]) => rows.map((r) => r.identifier)).catch(() => []);
      return res.json({
        candidates: extractCandidates(text, policy, { registry }),
        single: validateTag(text.trim(), policy),
      });
    } catch (e: any) {
      return res.status(500).json({ error: 'Не удалось проверить пример', details: e?.message });
    }
  });
}
