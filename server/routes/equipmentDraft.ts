import type { Express, Request, Response } from 'express';
import { getPrisma, upsertSetting } from '../context.js';
import { importEquipmentToDB } from '../equipmentImport.js';
import { parseEquipmentXML } from '../equipmentParser.js';
import { KIND_MAP_KEY, kindMap, parseOptionsFor } from '../equipmentFile.js';
import { SKIP_KIND } from '../vezaDict.js';
import { ROLES } from '../../equipment/roles.js';
import { TAG_MAX } from '../../equipment/tagPolicy.js';
import { planEquipmentImport, applyEdits, filterBySelection, type EditMap } from '../equipmentPlan.js';
import type { TagLink } from '../equipmentTags.js';

// ── Ввоз распознанного документа (PDF / Word / скан / буфер) ────────────────
// Мастер распознавания присылает уже разобранный документ, а не файл. Раньше
// этот путь писал в базу сразу: без плана, без предпросмотра и без отмены —
// качество ввоза зависело от того, каким файлом принесли бланк. Теперь оба
// пути идут одинаково: разбор → ПЛАН → предпросмотр (решает человек) → запись,
// поэтому здесь два эндпоинта на одной санитизации.

/**
 * Пределы присланного дерева.
 *
 * Раньше лишнее просто отрезалось `slice`, и человек об этом не узнавал: файл
 * на сто пятьдесят позиций импортировался как сто, и недостающие полсотни
 * искали потом руками. Теперь предел — это отказ с числом, а не тихая потеря.
 */
export const DRAFT_LIMITS = { units: 100, monoblocks: 50, blocks: 200, groups: 40, params: 200 };

export class DraftTooBig extends Error {
  constructor(public what: string, public limit: number, public got: number) {
    super(`${what}: прислано ${got} при пределе ${limit}. Разделите файл или увеличьте предел на сервере.`);
    this.name = 'DraftTooBig';
  }
}

/** Список с пределом: переполнение — отказ с числом, а не обрезка. */
function countedList(raw: any, what: string, limit: number): any[] {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length > limit) throw new DraftTooBig(what, limit, list.length);
  return list;
}

/** Управляющие и бинарные символы вырезаем: «кракозябры» в названия не попадают */
const clean = (s: any, max = 200) => String(s ?? '')
  // управляющие (C0/C1), область частного использования, замещающий символ
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uE000-\uF8FF\uFFFD]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

const cleanGroups = (groups: any): any[] => {
  const list = Array.isArray(groups) ? groups : [];
  if (list.length > DRAFT_LIMITS.groups) throw new DraftTooBig('Разделов параметров', DRAFT_LIMITS.groups, list.length);
  return list.map((g: any) => {
    const params = Array.isArray(g?.params) ? g.params : [];
    if (params.length > DRAFT_LIMITS.params) {
      throw new DraftTooBig('Параметров в разделе', DRAFT_LIMITS.params, params.length);
    }
    return {
      title: clean(g?.title, 80) || 'Характеристики',
      params: params.map((p: any) => ({
        key: clean(p?.key, 120), value: clean(p?.value, 300), unit: clean(p?.unit, 40),
        // Исходные коды выгрузки («ptgMOTOR», «ptNY») живут рядом со значением
        // и переживают переименование раздела: по ним подпозиция узнаёт свои
        // параметры, а шаблон вида не опустеет от правки названия столбца
        ...(p?.sourceGroup ? { sourceGroup: clean(p.sourceGroup, 60) } : {}),
        ...(p?.sourceKey ? { sourceKey: clean(p.sourceKey, 60) } : {}),
      })).filter((p: any) => p.key && p.value),
    };
  }).filter((g: any) => g.params.length);
};

/** Теги позиции. Длина — общая с правилом тегов, а не своя короче */
const cleanTags = (tags: any): string[] | undefined => {
  if (!Array.isArray(tags)) return undefined;
  if (tags.length > 50) throw new DraftTooBig('Тегов у позиции', 50, tags.length);
  const out = tags.map((t: any) => clean(t, TAG_MAX)).filter(Boolean);
  return out.length ? out : undefined;
};

/** Число из запроса: не число и не положительное — значит не прислали */
const cleanNum = (v: any, max: number): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= max ? Math.trunc(n) : undefined;
};

/**
 * Свидетельства о тегах — откуда взялся тег и что с ним решено.
 *
 * Едут вместе с позицией, а не считаются заново: разбор примечания видел
 * исходный текст, а санитайзер видит уже разобранное дерево. Потеряй мы их
 * здесь, предпросмотр показал бы связи без объяснения, а расхождение «три тега
 * привода при двух приводах» выглядело бы как ошибка программы.
 */
const cleanTagNotes = (raw: any): any[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  if (raw.length > 200) throw new DraftTooBig('Свидетельств о тегах', 200, raw.length);
  const out = raw.map((e: any) => ({
    identifier: clean(e?.identifier, TAG_MAX),
    verdict: clean(e?.verdict, 20),
    why: clean(e?.why, 300),
    ...(e?.fix ? { fix: clean(e.fix, TAG_MAX) } : {}),
    ...(e?.role ? { role: clean(e.role, 40) } : {}),
    ...(e?.phrase ? { phrase: clean(e.phrase, 500) } : {}),
  })).filter((e: any) => e.identifier);
  return out.length ? out : undefined;
};

/** Присланное дерево → та же модель, что даёт разбор файла на сервере */
export function sanitizeDraftUnits(units: any[]): any {
  if (units.length > DRAFT_LIMITS.units) throw new DraftTooBig('Установок', DRAFT_LIMITS.units, units.length);
  return {
    units: units.map((u: any) => ({
      name: clean(u?.name, 120) || 'Импорт',
      title: clean(u?.title, 200) || 'Импортированное оборудование',
      // Файл, из которого пришла установка: при ввозе нескольких файлов разом
      // у каждой установки свой, и в реестре должно остаться именно оно
      ...(u?.fileName ? { fileName: clean(u.fileName, 200) } : {}),
      tags: cleanTags(u?.tags),
      groups: cleanGroups(u?.groups),
      monoblocks: countedList(u?.monoblocks, 'Моноблоков', DRAFT_LIMITS.monoblocks).map((mb: any) => ({
        name: clean(mb?.name, 120) || 'M1',
        title: clean(mb?.title, 200) || '',
        blocks: countedList(mb?.blocks, 'Блоков в моноблоке', DRAFT_LIMITS.blocks).map((b: any) => ({
          name: clean(b?.name, 120) || 'Позиция',
          title: clean(b?.title, 200) || '',
          equipType: clean(b?.equipType, 60) || 'component',
          tags: cleanTags(b?.tags),
          groups: cleanGroups(b?.groups),
          /**
           * Состав едет через санитайзер целиком.
           *
           * Это не мелочь: мастер распознавания — та самая дорога, по которой
           * человек приносит расчёт (обращение ОБР-000006). Отбрось санитайзер
           * роль и владельца, и двигатель дошёл бы до реестра соседом
           * вентилятора, а родителя тега взять было бы неоткуда — причём молча.
           */
          ...(b?.role ? { role: clean(b.role, 40) } : {}),
          ...(b?.parentName ? { parentName: clean(b.parentName, 120) } : {}),
          ...(b?.sourceKind ? { sourceKind: clean(b.sourceKind, 60) } : {}),
          ...(cleanNum(b?.instanceNo, 10000) ? { instanceNo: cleanNum(b.instanceNo, 10000) } : {}),
          ...(cleanNum(b?.instanceCount, 10000) ? { instanceCount: cleanNum(b.instanceCount, 10000) } : {}),
          ...(cleanNum(b?.sourceOrder, 1000000) ? { sourceOrder: cleanNum(b.sourceOrder, 1000000) } : {}),
          ...(b?.position ? { position: clean(b.position, 60) } : {}),
          ...(b?.note ? { note: clean(b.note, 4000) } : {}),
          ...(cleanTagNotes(b?.tagNotes) ? { tagNotes: cleanTagNotes(b.tagNotes) } : {}),
        })),
      })),
    })),
  };
}

const TAG_ACTIONS = new Set(['link', 'create', 'skip', 'ambiguous', 'invalid']);

/**
 * Решения инженера по тегам — как есть, без «приведения к разумному».
 *
 * Раньше всё, кроме `create` и `skip`, превращалось в `link`. В том числе
 * `ambiguous` — честное «в проекте несколько похожих, выберите». Превращённое
 * в `link` без указанного тега, оно доходило до записи, и следующий слой
 * заводил НОВЫЙ тег: защита от неоднозначности обходилась сама собой.
 *
 * Теперь неизвестное действие — отказ, а `link` без тега бессмыслен и
 * становится `ambiguous`: пусть человек выберет, а не программа угадает.
 */
export function cleanTagLinks(raw: any): TagLink[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  if (raw.length > 2000) throw new DraftTooBig('Решений по тегам', 2000, raw.length);
  const out = raw.map((l: any) => {
    const action = String(l?.action || '');
    if (!TAG_ACTIONS.has(action)) throw new Error(`Неизвестное действие с тегом: «${action || 'пусто'}»`);
    const existingTagId = l?.existingTagId ? String(l.existingTagId).slice(0, 64) : undefined;
    return {
      blockKey: String(l?.blockKey ?? '').slice(0, 300),
      // Предел длины тега общий с правилом (equipment/tagPolicy.ts): прежние
      // 40 знаков молча резали длинные обозначения
      identifier: String(l?.identifier ?? '').trim().slice(0, TAG_MAX),
      action: (action === 'link' && !existingTagId) ? 'ambiguous' : action,
      existingTagId,
    };
  }).filter((l: any) => l.blockKey && l.identifier) as TagLink[];
  return out.length ? out : undefined;
}

export class ProjectRequired extends Error {
  constructor() {
    super('Не выбран проект. Импорт оборудования ведётся по проекту — выберите его и повторите.');
    this.name = 'ProjectRequired';
  }
}

/**
 * Проект берётся из запроса и только из него.
 *
 * Раньше пустой проект означал «возьмём первый попавшийся, а если проектов
 * нет — заведём „Общий Проект“». Это делал в том числе ПРЕДПРОСМОТР, который
 * ничего писать не должен: посмотрел, что получится, — и в базе новый проект.
 * А импорт при этом мог уехать в чужой проект, открытый у кого-то другого.
 */
async function resolveProject(reqProjectId: any): Promise<string> {
  const projectId = String(reqProjectId || '');
  if (!projectId || ['null', 'undefined', 'default'].includes(projectId)) throw new ProjectRequired();
  const project = await getPrisma().project.findUnique({ where: { id: projectId } });
  if (!project) throw new ProjectRequired();
  return projectId;
}

/**
 * Понятный отказ вместо «500 Внутренняя ошибка».
 *
 * Переполненное дерево и невыбранный проект — это не поломка сервера, а
 * разговор с человеком: он может разделить файл или выбрать проект. Код нужен
 * окну, текст — человеку.
 */
export function draftFailure(error: any): { code: string; error: string } | null {
  if (error instanceof DraftTooBig) return { code: 'IMPORT_LIMIT_EXCEEDED', error: error.message };
  if (error instanceof ProjectRequired) return { code: 'PROJECT_REQUIRED', error: error.message };
  if (String(error?.message || '').startsWith('Неизвестное действие с тегом')) {
    return { code: 'TAG_ACTION_UNKNOWN', error: error.message };
  }
  return null;
}

export function registerEquipmentDraftRoutes(app: Express): void {
  /**
   * Незнакомый вид узла выгрузки → роль.
   *
   * Предпросмотр показывает виды, которых программа не знает, и человек
   * относит вид к роли (или помечает «не позиция»). Ответ живёт в общей
   * настройке компании и работает на всех следующих ввозах у всех сотрудников:
   * одна и та же новинка САПР не должна объясняться программе двадцать раз.
   */
  app.put('/api/equipment/veza-kinds', async (req: Request, res: Response) => {
    const kind = clean(req.body?.kind, 80);
    const role = clean(req.body?.role, 40);
    if (!/^cad[A-Za-z0-9]+$/.test(kind)) return res.status(400).json({ error: 'Вид узла не похож на вид выгрузки САПР' });
    const known = role === SKIP_KIND || ROLES.some(r => r.id === role);
    if (!known && role !== '') return res.status(400).json({ error: 'Такой роли нет' });
    try {
      const map = await kindMap();
      if (role) map[kind] = role; else delete map[kind];
      await upsertSetting(KIND_MAP_KEY, null, JSON.stringify(map));
      console.log(`[Оборудование] Вид ${kind} отнесён к роли «${role || 'не задано'}»`);
      return res.json({ kinds: map });
    } catch (e: any) {
      return res.status(500).json({ error: 'Не удалось сохранить', details: e?.message });
    }
  });

  /**
   * Разбор расчёта, принесённого прямо в мастер, — без Проводника.
   *
   * Выгрузка САПР устроена так, что распознавать её нечем: там не бланк с
   * парами «ключ — значение», а плоский словарь из десятков тысяч узлов, и
   * разбирает его отдельный движок на сервере. Раньше мастер в этом месте
   * заканчивался советом пойти в «Оборудование» → «Импорт расчёта» — кнопки с
   * таким именем там нет, и человек оставался ни с чем. Теперь файл
   * разбирается тем же движком и попадает в тот же предпросмотр.
   *
   * Ничего не пишет: это чтение, как и план.
   */
  app.post('/api/equipment/parse-calc', async (req: Request, res: Response) => {
    const text = String(req.body?.text || '');
    if (!text.trim()) return res.status(400).json({ error: 'Пустой файл' });
    try {
      // Проект нужен и здесь: по его коду в примечаниях ищутся теги
      const projectId = String(req.body?.projectId || '');
      const result = parseEquipmentXML(text, await parseOptionsFor(projectId || undefined));
      if (!result.units.length) {
        return res.status(400).json({
          error: 'В файле не нашлось установок. Похоже, это не выгрузка расчёта — попробуйте импорт бланка.',
        });
      }
      res.json({ units: result.units, fileName: clean(req.body?.fileName, 200) || 'Расчёт' });
    } catch (error: any) {
      console.error('Error in parse-calc:', error);
      res.status(400).json({ error: 'Не удалось прочитать файл как расчёт' });
    }
  });

  // План по распознанному документу: тот же дифф, те же теги, что у файла.
  // Ничего не пишет — предпросмотр обязан быть безопасным.
  app.post('/api/equipment/import-draft-plan', async (req: Request, res: Response) => {
    const { units, category, projectId: reqProjectId, edits } = req.body;
    if (!Array.isArray(units) || units.length === 0) {
      return res.status(400).json({ error: 'Пустой результат распознавания' });
    }
    if (!category) return res.status(400).json({ error: 'Не указана категория оборудования' });
    try {
      const projectId = await resolveProject(reqProjectId);
      const result = applyEdits(sanitizeDraftUnits(units), edits as EditMap | undefined);
      const plan = await planEquipmentImport(getPrisma(), projectId, category, result);
      res.json({ plan });
    } catch (error: any) {
      const known = draftFailure(error);
      if (known) return res.status(400).json(known);
      console.error('Error in import-draft-plan:', error);
      return res.status(500).json({ error: error.message || 'Не удалось построить план' });
    }
  });

  // Запись подтверждённого предпросмотра
  app.post('/api/equipment/import-draft', async (req: Request, res: Response) => {
    const { units, category, fileName, projectId: reqProjectId, tagLinks, edits, selection } = req.body;
    if (!Array.isArray(units) || units.length === 0) {
      return res.status(400).json({ error: 'Пустой результат распознавания' });
    }
    if (!category) return res.status(400).json({ error: 'Не указана категория оборудования' });
    try {
      const prisma = getPrisma();
      const projectId = await resolveProject(reqProjectId);
      // Правки предпросмотра и выбор области — до записи, как у ввоза файла
      const edited = applyEdits(sanitizeDraftUnits(units), edits as EditMap | undefined);
      const sel = Array.isArray(selection) ? new Set<string>(selection) : null;
      const result = filterBySelection(edited, sel);
      if (!result.units.length) {
        return res.status(400).json({ error: 'Не выбрано ни одного блока для импорта' });
      }

      const modeSetting = await prisma.appSetting.findFirst({ where: { key: 'equip_conflict_mode', userId: null } });
      const conflictMode: 'immediate' | 'wait' = (modeSetting && modeSetting.value === 'immediate') ? 'immediate' : 'wait';

      const summary = await importEquipmentToDB(
        prisma, projectId, category,
        clean(fileName, 200) || 'Распознанный документ',
        result, conflictMode, cleanTagLinks(tagLinks),
      );
      res.json({ success: true, ...summary, conflictMode });
    } catch (error: any) {
      const known = draftFailure(error);
      if (known) return res.status(400).json(known);
      console.error('Error in import-draft:', error);
      return res.status(500).json({ error: error.message || 'Не удалось импортировать распознанные данные' });
    }
  });
}
