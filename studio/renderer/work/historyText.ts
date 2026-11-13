/** Подписи истории версий для окна. Значения причин — те же, что в studio/shared/history.ts (сам модуль в окно не подключается: он работает с диском) */
import type { SnapshotInfo, SnapshotReason } from '../../shared/history';

export const REASON_TEXT: Record<SnapshotReason, string> = { manual: 'Сохранена вручную', build: 'Сборка', publish: 'Отправка', 'before-rollback': 'Перед откатом' };
export const REASON_TONE: Record<SnapshotReason, 'slate' | 'emerald' | 'amber' | 'sky'> = { manual: 'emerald', build: 'slate', publish: 'sky', 'before-rollback': 'amber' };

export const formatTime = (time: number) => new Date(time).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** «13.11.2026, 10:15 · Отправка 0.2.0» — так версия названа в списках выбора и в окнах */
export const snapshotTitle = (s: SnapshotInfo) => `${formatTime(s.time)} · ${REASON_TEXT[s.reason]}${s.version ? ` ${s.version}` : ''}`;
