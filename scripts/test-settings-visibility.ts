import { canSeeSettingsSection, settingsSectionFromQuery } from '../src/lib/settingsVisibility';

const check = (name: string, passed: boolean) => {
  if (!passed) throw new Error(`FAIL: ${name}`);
  console.log(`OK: ${name}`);
};

const ordinary = { id: 'staff', role: 'ENGINEER_VENT' };
const admin = { id: 'admin', role: 'ADMIN' };
const owner = { id: 'owner', role: 'OWNER' };

check('ordinary user sidebar visibility excludes browser and translator',
  !canSeeSettingsSection('browser', ordinary) && !canSeeSettingsSection('translate', ordinary));
check('owner sidebar visibility includes browser and translator',
  canSeeSettingsSection('browser', owner) && canSeeSettingsSection('translate', owner));
check('administrator is not the owner: browser and translator stay hidden',
  !canSeeSettingsSection('browser', admin) && !canSeeSettingsSection('translate', admin));
check('ordinary user direct browser and translator queries resolve to general before rendering',
  settingsSectionFromQuery('browser', ordinary) === 'general' && settingsSectionFromQuery('translate', ordinary) === 'general');
check('owner direct browser and translator queries remain selected',
  settingsSectionFromQuery('browser', owner) === 'browser' && settingsSectionFromQuery('translate', owner) === 'translate');
check('administrator direct browser and translator queries resolve to general',
  settingsSectionFromQuery('browser', admin) === 'general' && settingsSectionFromQuery('translate', admin) === 'general');
check('unrestricted and missing section queries retain normal settings behavior',
  settingsSectionFromQuery('backup', ordinary) === 'backup' && settingsSectionFromQuery(null, ordinary) === 'general');

console.log('Settings visibility checks passed.');
