/**
 * Что экран «Проекты» держит открытым: проект, чья карточка открыта на правку.
 *
 * Пока человек правит карточку, коллега не должен удалить проект из-под рук:
 * служба ответит ему, у кого проект открыт. Просто выбранный в переключателе
 * проект открытым не считается — у него нет формы, которую можно потерять.
 * Название модели — как в схеме базы: по нему сервер находит запись.
 */
import { useOpenRecords } from '../useOpenRecords';

export const PROJECT_MODEL = 'Project';

export function useProjectOpenRecords(editingProjectId: string | null | undefined): void {
  useOpenRecords('projects', editingProjectId ? [{ model: PROJECT_MODEL, id: editingProjectId }] : []);
}
