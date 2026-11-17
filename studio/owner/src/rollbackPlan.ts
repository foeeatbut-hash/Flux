/**
 * «Вернуть предыдущую версию всем»: что именно вернётся и у кого.
 *
 * Один расчёт на окно и на главный процесс: окно показывает владельцу, что произойдёт, а главный
 * процесс пересчитывает по свежему списку перед подписью и подписывает только его (окну он не верит).
 *
 * Решение руководителя (владелец не подтверждал): возврат — это обязательное обновление на предыдущую
 * выпущенную версию; новый выпуск не создаётся. «Предыдущая» — самая новая из опубликованных, что ниже
 * самой высокой версии, которая сейчас стоит у сотрудников: так возврат не промахивается, когда
 * свежий выпуск опубликован, но ещё никому не назначен.
 */
import { compareVersions } from '../../../shared/versionCompare';

export interface RollbackDevice { deviceId: string; userId: string; version: string; commandId: string | null }
export interface RollbackRelease { version: string; generation: string; signature: string; sha256: string }
export interface RollbackPlan {
  /** Самая высокая версия, что стоит у сотрудников сейчас */
  top: string;
  release: RollbackRelease;
  targets: RollbackDevice[];
  /** Сколько сотрудников затронуто (на одного человека бывает несколько компьютеров) */
  people: number;
}

export function rollbackPlan(devices: RollbackDevice[], releases: RollbackRelease[]): RollbackPlan | { error: string } {
  const known = devices.filter(d => d.version);
  if (!known.length) return { error: 'Версии компьютеров неизвестны: возвращать нечего.' };
  const top = known.reduce((best, d) => (compareVersions(d.version, best) > 0 ? d.version : best), known[0].version);
  const ordered = [...releases].sort((a, b) => compareVersions(b.version, a.version));
  const release = ordered.find(r => compareVersions(r.version, top) < 0);
  if (!release) return { error: `Нет опубликованной версии ниже ${top}: возвращаться некуда.` };
  const targets = known.filter(d => compareVersions(d.version, release.version) > 0);
  return { top, release, targets, people: new Set(targets.map(d => d.userId)).size };
}
