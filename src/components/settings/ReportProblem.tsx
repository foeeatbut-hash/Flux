/**
 * «Сообщить об ошибке» из Настроек.
 *
 * Отсюда когда-то уходило сообщение в общий канал «Ошибки» — оно жило в
 * переписке обычной репликой, без номера, состояния и ответа автору.
 *
 * Теперь здесь не форма, а вызов той же двери, что и у кнопки в верхней
 * панели: `openProblemPanel`. Второй формы в программе быть не должно, иначе
 * два входа снова начнут расходиться в поведении — а привычное место в
 * Настройках сохранено намеренно: человек ищет «Сообщить об ошибке» там, где
 * нажимал год.
 */
import { useEffect } from 'react';
import { openProblemPanel } from '../../feedback/problemPanel';

export default function ReportProblem({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    openProblemPanel({ sectionKey: window.location.hash.replace(/^#/, '') || '/settings' });
    onClose();
  }, [onClose]);
  return null;
}
