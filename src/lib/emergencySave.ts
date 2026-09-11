/**
 * Аварийное сохранение журнала на закрытии окна.
 *
 * Жило внутри виджета журнала — того самого, который убран из верхней панели.
 * Это скрытая мина: удаление интерфейсного компонента забирало с собой
 * запись аварии, и никто бы этого не заметил, пока не понадобилось бы
 * разбирать падение. Регистратор не имеет отношения к интерфейсу и живёт
 * теперь в старте программы.
 *
 * Оговорка честная: `beforeunload` срабатывает при закрытии окна, но НЕ при
 * убийстве процесса. Полагаться только на него нельзя, и полный ответ на
 * аварии даёт диагностика с её маркером корректного завершения. Это —
 * последний штрих для обычного закрытия.
 */

import { useLogStore } from '../store/logStore';
import { useStore } from '../store/store';

/** Человекочитаемая должность. Переехала сюда вместе с единственным вызовом. */
function roleLabel(role?: string): string {
  switch (role) {
    case 'ADMIN': return 'Администратор';
    case 'MANAGER': return 'Менеджер проектов';
    case 'ENGINEER_VENT': return 'Инженер ОВиК';
    case 'ENGINEER_AUTO': return 'Инженер КИПиА';
    default: return role || '—';
  }
}

let registered = false;

function snapshot(): string {
  const logs = useLogStore.getState().logs;
  const user = (() => { try { return useStore.getState().user; } catch (_) { return null; } })();
  const project = (() => { try { return useStore.getState().activeProject; } catch (_) { return null; } })();

  const header = [
    '==================== ЖУРНАЛ FLUX ====================',
    `Дата выгрузки : ${new Date().toISOString()}`,
    `Пользователь  : ${user?.name || '— (вход не выполнен)'}`,
    `Логин         : ${user?.symbol || '—'}`,
    `Должность     : ${roleLabel(user?.role)}`,
    `Активный проект: ${project?.name || '—'}`,
    `Записей в журнале: ${logs.length}`,
    '=====================================================',
    '',
  ].join('\n');

  return header + logs
    .map((l) => `[${l.timestamp}] [${l.type}] [${l.context}] ${l.message}${l.stack ? `\nStack:\n${l.stack}` : ''}`)
    .join('\n');
}

/** Поставить обработчик один раз за запуск. Повторный вызов ничего не делает. */
export function registerEmergencySave(): void {
  if (registered || typeof window === 'undefined') return;
  registered = true;
  window.addEventListener('beforeunload', () => {
    const shell = (window as any).electron;
    if (shell && typeof shell.emergencySave === 'function') {
      try { shell.emergencySave(snapshot()); } catch (_) { /* оболочка уже закрылась */ }
    }
  });
}
