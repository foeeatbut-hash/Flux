/** Список действий окна: единственное место, откуда его берут главный процесс и предзагрузка */
export const SHELL_ACTIONS = ['state', 'connect', 'connectRemembered', 'forgetBase', 'login', 'logout', 'disconnect', 'modules', 'openSection', 'cancel'] as const;
export const DEVELOPER_ACTIONS = [
  'keyInfo', 'keyCreate', 'keyRequest', 'keyCertificate',
  'templates', 'drafts', 'draftCreate', 'draftImport', 'draftTree', 'draftFile', 'draftSave', 'draftRemoveFile', 'draftRemove', 'draftState',
  'testBase', 'testBaseReset',
  'runStart', 'runRead', 'runCompute', 'runShot',
  'check', 'publish', 'requests', 'errors', 'errorFixed',
] as const;
export type DeveloperAction = typeof DEVELOPER_ACTIONS[number];
export const ALL_ACTIONS: readonly string[] = [...SHELL_ACTIONS, ...DEVELOPER_ACTIONS];
