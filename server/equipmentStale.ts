/**
 * Тексты отказов «запись уже изменили» и ответ 400 для маршрутов оборудования
 * (docs/roadmap/offline-work.md, 0.5). Сверку версии делает server/versionGuard.ts;
 * здесь только выбор слова для человека: сами тексты — в словаре
 * src/lib/refusalTexts.ts (его берёт и клиент), чтобы поштучные маршруты
 * оборудования не носили каждый свою копию.
 *
 * Кто и когда изменил запись, сказать нечем: у позиции `updatedAt` не ведётся
 * (колонка без @updatedAt, пишет её только создание), у установки и моноблока
 * её нет, а автора правки не хранит ни одна из трёх моделей.
 */

import type { Response } from 'express';
import { editChangedText, deleteChangedText, createInsideChangedText } from '../src/lib/refusalTexts.js';

const named = (c: any) => (c?.name || c?.itemCode || '').toString().trim();

/** Позицию (ComponentElement) изменили, пока её правили. */
export const staleElement = (current: any): string => editChangedText('position', named(current));
/** …после того, как её открыли, и удалить её хотят. */
export const staleElementDelete = (current: any): string => deleteChangedText('position', named(current));
/** …а внутрь неё добавляют новую позицию. */
export const staleElementInside = (current: any): string => createInsideChangedText('position', named(current));

/** Установку (EquipmentSystem) изменили, пока её правили. */
export const staleSystem = (current: any): string => editChangedText('system', named(current));
/** …после того, как её открыли, и удалить её хотят. */
export const staleSystemDelete = (current: any): string => deleteChangedText('system', named(current));
/** …а внутрь неё добавляют запись. */
export const staleSystemInside = (current: any): string => createInsideChangedText('system', named(current));

/** Блок (Monoblock), в который заводят позицию. */
export const staleMonoblock = (current: any): string => createInsideChangedText('block', named(current));

/** 400: присланная версия не читается — не принимаем за «версии нет» и не пишем вслепую. */
export const badVersion = (res: Response): unknown => res.status(400).json({ error: 'Ожидаемая версия записи не читается' });
