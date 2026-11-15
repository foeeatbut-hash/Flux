/**
 * Тексты отказов «запись уже изменили» и ответ 400 для маршрутов оборудования
 * (docs/roadmap/offline-work.md, 0.5). Сверку версии делает server/versionGuard.ts;
 * здесь только слова для человека, чтобы поштучные маршруты оборудования не
 * носили каждый свою копию.
 *
 * Кто и когда изменил запись, сказать нечем: у позиции `updatedAt` не ведётся
 * (колонка без @updatedAt, пишет её только создание), у установки и моноблока
 * её нет, а автора правки не хранит ни одна из трёх моделей.
 */

import type { Response } from 'express';

const TAIL = 'Показана текущая версия — ваши правки не записаны.';

const named = (c: any) => (c?.name || c?.itemCode || '').toString().trim();

/** Позицию (ComponentElement) изменили после того, как её показали клиенту. */
export const staleElement = (current: any): string => `Позицию${named(current) ? ` «${named(current)}»` : ''} изменили, пока вы её правили. ${TAIL}`;

/** Установку (EquipmentSystem). */
export const staleSystem = (current: any): string => `Установку${named(current) ? ` «${named(current)}»` : ''} изменили, пока вы её правили. ${TAIL}`;

/** Моноблок (Monoblock), в который заводят позицию. */
export const staleMonoblock = (current: any): string => `Моноблок${named(current) ? ` «${named(current)}»` : ''} изменили, пока вы с ним работали. ${TAIL}`;

/** 400: присланная версия не читается — не принимаем за «версии нет» и не пишем вслепую. */
export const badVersion = (res: Response): unknown => res.status(400).json({ error: 'Ожидаемая версия записи не читается' });
