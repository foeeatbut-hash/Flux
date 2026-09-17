/**
 * Разметка и сборка таблицы — состояние и действия.
 *
 * Отдельно от экрана редактора, потому что экран стоит у планки размера, а
 * здесь набирается сотня строк: каталог, шаблоны, привязка поля, сборка,
 * разбор расхождений. Правила при этом лежат ещё уровнем ниже —
 * `lib/tableLayout` и `lib/tableBlock`, — и проверяются скриптом. Тут только
 * склейка: запросы к серверу и вызовы движка таблиц.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  emptyLayout, bindColumn, unbindColumn, diffLayout, layoutToTemplate, templateToLayout,
  type CatalogField, type LayoutDiff, type ProjectCatalog, type TableLayout,
} from '../../lib/tableLayout';
import {
  paintHeader, clearHeaderCell, readColumnValues, writeColumnValues, clearColumnValues,
  nextFreeColumn,
} from '../../lib/tableBlock';

export interface SavedTemplate {
  id: string; name: string; scope: string; grain: string;
  columns: { path: string; title: string; unit?: string }[];
  filters: { field: string; op: string; value: string }[];
}

/** Что запомнено с прошлой сборки: по нему и считается расхождение. */
interface Collected {
  keys: string[];
  written: string[][];
}

export function useTableLayout(opts: {
  projectId: string;
  /** Активный лист движка. `null`, пока книга не открылась */
  getSheet: () => any | null;
  /** Где сейчас курсор: строка и столбец активной ячейки */
  getCursor: () => { row: number; col: number } | null;
  say: (text: string, kind?: 'success' | 'error' | 'info') => void;
  /** Разметку хранит документ — экран кладёт её в свои привязки */
  onChanged: (layout: TableLayout) => void;
  initial?: TableLayout | null;
}) {
  const { projectId, getSheet, getCursor, say, onChanged } = opts;

  const [layout, setLayout] = useState<TableLayout>(() => opts.initial || emptyLayout());
  const [catalog, setCatalog] = useState<ProjectCatalog | null>(null);
  const [templates, setTemplates] = useState<SavedTemplate[]>([]);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diff, setDiff] = useState<LayoutDiff | null>(null);
  const [busy, setBusy] = useState(false);
  const collected = useRef<Collected>({ keys: [], written: [] });

  /** Правка разметки: и в состояние, и в документ — иначе потеряется при закрытии */
  const change = useCallback((next: TableLayout) => {
    setLayout(next);
    onChanged(next);
  }, [onChanged]);

  // Каталог полей проекта. Перечитывается при смене проекта: поля разные
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    fetch(`/api/constructor/catalog?projectId=${encodeURIComponent(projectId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d) setCatalog(d); })
      .catch(() => { /* каталог не пришёл — панель скажет, что собирать нечего */ });
    return () => { alive = false; };
  }, [projectId]);

  const loadTemplates = useCallback(() => {
    fetch('/api/table-templates')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.templates) setTemplates(d.templates); })
      .catch(() => { /* шаблонов нет — панель покажет пустую полку */ });
  }, []);
  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  /** Куда встанет поле: в выделенную ячейку, а не «куда-нибудь». */
  const targetCol = useCallback((): { row: number; col: number } => {
    const cur = getCursor();
    if (cur) return cur;
    return { row: layout.headerRow, col: nextFreeColumn(layout) };
  }, [getCursor, layout]);

  const pickField = useCallback((field: CatalogField) => {
    const at = targetCol();
    // Шапка переезжает на строку, где человек выбрал первую ячейку: он
    // показал, где начинается таблица, и спорить с ним незачем
    const base = layout.columns.length ? layout : { ...layout, headerRow: at.row };
    const next = bindColumn(base, at.col, field);
    change(next);
    const ws = getSheet();
    if (ws) paintHeader(ws, { ...next, columns: [{ ...field, col: at.col }] }, false);
  }, [targetCol, layout, change, getSheet]);

  const dropField = useCallback((col: number) => {
    const ws = getSheet();
    if (ws) clearHeaderCell(ws, layout.headerRow, col);
    change(unbindColumn(layout, col));
  }, [getSheet, layout, change]);

  const setGrain = useCallback((grain: string) => {
    // Поля одного вида строки не годятся другому: сменили — разметка начинается
    // заново. Молча оставить старые столбцы значило бы собрать пустую таблицу
    if (grain === layout.grain) return;
    const ws = getSheet();
    if (ws) for (const c of layout.columns) clearHeaderCell(ws, layout.headerRow, c.col);
    change({ ...emptyLayout(grain, layout.headerRow) });
  }, [layout, getSheet, change]);

  const clearLayout = useCallback(() => {
    const ws = getSheet();
    if (ws) for (const c of layout.columns) clearHeaderCell(ws, layout.headerRow, c.col);
    change(emptyLayout(layout.grain, layout.headerRow));
    collected.current = { keys: [], written: [] };
    setDiff(null);
  }, [layout, getSheet, change]);

  /** Запрос строк проекта по текущей разметке. */
  const ask = useCallback(async (): Promise<{ keys: string[]; cells: string[][] } | null> => {
    const res = await fetch('/api/constructor/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId, entity: layout.grain,
        columns: layout.columns.map((c) => c.path),
        filters: layout.filters, limit: 50000,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      keys: (data.rows || []).map((r: any) => String(r.key)),
      cells: (data.rows || []).map((r: any) => (r.cells || []).map((v: any) => String(v ?? ''))),
    };
  }, [projectId, layout]);

  /**
   * Собрать значения.
   *
   * Первая сборка просто пишет. Повторная сначала считает расхождение и НИЧЕГО
   * не пишет, если есть что решать: обновление, которое молча затирает правку
   * человека, — самая дорогая ошибка здесь.
   */
  const collect = useCallback(async () => {
    if (!layout.columns.length) { say('Сначала разметьте шапку: выберите поля для столбцов', 'info'); return; }
    const ws = getSheet();
    if (!ws) return;
    setBusy(true);
    try {
      const got = await ask();
      if (!got) { say('Не удалось получить данные проекта', 'error'); return; }
      const top = layout.headerRow + 1;
      const was = collected.current;

      if (was.keys.length) {
        const current = readColumnValues(ws, layout, top, was.keys.length);
        const fresh = new Map(got.keys.map((k, i) => [k, got.cells[i]]));
        const d = diffLayout({ wasKeys: was.keys, written: was.written, current, fresh, columns: layout.columns });
        setDiff(d);
        if (d.asks > 0) {
          setDiffOpen(true);
          say(`${d.asks} значений требуют решения — откройте «Расхождения»`, 'info');
          return;
        }
      }

      // Старые строки стираем целиком: иначе от прошлой сборки остаются хвосты
      if (was.keys.length > got.keys.length) {
        clearColumnValues(ws, layout, top + got.keys.length, was.keys.length - got.keys.length);
      }
      writeColumnValues(ws, layout, top, got.cells);
      paintHeader(ws, layout, true);
      collected.current = { keys: got.keys, written: got.cells };
      setDiff(null);
      say(`Собрано строк: ${got.keys.length}`, 'success');
    } catch (_) {
      say('Не удалось собрать данные', 'error');
    } finally { setBusy(false); }
  }, [layout, getSheet, ask, say]);

  /** Принять данные проекта: пишем свежее целиком, вместе со спорными клетками. */
  const applyFresh = useCallback(async () => {
    const ws = getSheet();
    if (!ws) return;
    setBusy(true);
    try {
      const got = await ask();
      if (!got) { say('Не удалось получить данные проекта', 'error'); return; }
      const top = layout.headerRow + 1;
      const was = collected.current;
      if (was.keys.length > got.keys.length) {
        clearColumnValues(ws, layout, top + got.keys.length, was.keys.length - got.keys.length);
      }
      writeColumnValues(ws, layout, top, got.cells);
      paintHeader(ws, layout, true);
      collected.current = { keys: got.keys, written: got.cells };
      setDiff(null);
      setDiffOpen(false);
      say('Данные проекта приняты', 'success');
    } finally { setBusy(false); }
  }, [getSheet, ask, layout, say]);

  /** Оставить своё: расхождение закрывается, лист не трогаем. */
  const keepMine = useCallback(() => {
    const ws = getSheet();
    if (ws) {
      const top = layout.headerRow + 1;
      // Запоминаем как «записанное» то, что сейчас в листе: иначе следующая
      // сборка опять объявит правку человека расхождением
      collected.current = {
        keys: collected.current.keys,
        written: readColumnValues(ws, layout, top, collected.current.keys.length),
      };
    }
    setDiff(null);
    setDiffOpen(false);
    say('Оставлено как есть', 'info');
  }, [getSheet, layout, say]);

  const saveTemplate = useCallback(async (name: string, personal: boolean) => {
    const body = layoutToTemplate(layout);
    const res = await fetch('/api/table-templates', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, scope: personal ? 'PERSONAL' : 'SHARED', ...body }),
    });
    if (!res.ok) { say('Не удалось сохранить шаблон', 'error'); return; }
    loadTemplates();
    say(`Шаблон «${name}» сохранён`, 'success');
  }, [layout, say, loadTemplates]);

  const applyTemplate = useCallback((id: string) => {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    const ws = getSheet();
    const at = getCursor() || { row: layout.headerRow, col: 0 };
    if (ws) for (const c of layout.columns) clearHeaderCell(ws, layout.headerRow, c.col);
    const next = templateToLayout({ grain: t.grain, columns: t.columns, filters: t.filters }, at);
    change(next);
    if (ws) paintHeader(ws, next, false);
    collected.current = { keys: [], written: [] };
    say(`Шаблон «${t.name}» разложен — нажмите «Собрать»`, 'success');
  }, [templates, getSheet, getCursor, layout, change, say]);

  const deleteTemplate = useCallback(async (id: string) => {
    await fetch(`/api/table-templates/${id}`, { method: 'DELETE' }).catch(() => null);
    loadTemplates();
  }, [loadTemplates]);

  return {
    layout, catalog, templates, diff, busy,
    fieldsOpen, setFieldsOpen, diffOpen, setDiffOpen,
    pickField, dropField, setGrain, clearLayout, collect, applyFresh, keepMine,
    saveTemplate, applyTemplate, deleteTemplate,
  };
}
