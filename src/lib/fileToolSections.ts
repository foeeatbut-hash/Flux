import { resolveSectionPath } from './sectionAliases';

/** Старые закрепления не должны возвращать встроенные действия как программы. */
export const FILE_TOOL_PATHS = ['/doc', '/sheet', '/pdf', '/archives', '/office-doc', '/office-sheet', '/windows-file'] as const;
export function isFileToolPath(path: string): boolean {
  return (FILE_TOOL_PATHS as readonly string[]).includes(resolveSectionPath(path.split('?')[0].split('#')[0]));
}
