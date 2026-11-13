/** Список действий окна: единственное место, откуда его берут главный процесс и предзагрузка */
export const SHELL_ACTIONS = ['state', 'connect', 'connectRemembered', 'forgetBase', 'fluxBase', 'connectFlux', 'login', 'ownerSelectKey', 'ownerLogin', 'logout', 'disconnect', 'modules', 'openSection', 'cancel'] as const;
export const DEVELOPER_ACTIONS = [
  'keyInfo', 'keyCreate', 'keyRequest', 'keyRequestSend', 'keyCertificate',
  'templates', 'drafts', 'draftCreate', 'draftImport', 'draftTree', 'draftFile', 'draftBinary', 'draftSave', 'draftRemoveFile', 'draftRemove', 'draftState',
  'projectOpenFolder', 'projectWatch', 'projectUnwatch', 'projectExport', 'projectImportArchive', 'fileMkdir', 'fileRename', 'fileSearch', 'fileImport', 'keyEnsure',
  'testBase', 'testBaseReset',
  'build', 'runStart', 'runRead', 'runCompute', 'runShot', 'runPickFile', 'runNet', 'runConnect', 'runConnectAnswer', 'runStop', 'runProgram', 'runSaveFile', 'testPrograms', 'testProgramInstall', 'testProgramRemove', 'devRunStart', 'devRunStop', 'devRunState',
  'historyList', 'historySave', 'historyCompare', 'historyPlan', 'historyRollback', 'historyRemove',
  'ownerNotes', 'releaseList',
  'check', 'publish', 'requests', 'errors', 'errorFixed',
] as const;
export type DeveloperAction = typeof DEVELOPER_ACTIONS[number];
export const ALL_ACTIONS: readonly string[] = [...SHELL_ACTIONS, ...DEVELOPER_ACTIONS];
