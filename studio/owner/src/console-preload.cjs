'use strict';
// Мост окна разделов владельца: только перечисленные действия и три события. Токен и ключи сюда не попадают.
const { contextBridge, ipcRenderer } = require('electron');
const allowed = ['state', 'unlock', 'connect', 'disconnect', 'lock', 'cancel', 'requests', 'request', 'returnRequest', 'rejectRequest', 'release', 'ownerEdit',
  'releases', 'testers', 'saveTesters', 'promote', 'pin', 'revoke', 'certificates', 'certify', 'declineCertificate', 'devices', 'assignUpdate', 'trialLoad', 'trialPickFile', 'openLicenses'];
const subscribe = channel => fn => {
  if (typeof fn !== 'function') return () => {};
  const listener = (_event, data) => fn(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('ownerConsole', Object.freeze({
  call: (action, args = {}) => allowed.includes(action) ? ipcRenderer.invoke('console:action', action, args) : Promise.resolve({ ok: false, error: 'Недоступное действие.' }),
  onLocked: subscribe('console:locked'),
  onDisconnected: subscribe('console:disconnected'),
  onTab: subscribe('console:tab'),
}));
