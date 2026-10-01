import { testCredentials } from './testCredentials';

let passed = 0;
const check = (name: string, condition: boolean) => {
  if (!condition) throw new Error(`✗ ${name}`);
  passed++;
};

let missingUserRejected = false;
try { testCredentials({ FLUX_PASS: 'synthetic-password' }); }
catch (error) { missingUserRejected = error instanceof Error && error.message.includes('FLUX_USER'); }
check('live-проверка без логина останавливается с подсказкой', missingUserRejected);

let missingPassRejected = false;
try { testCredentials({ FLUX_USER: 'test.user' }); }
catch (error) { missingPassRejected = error instanceof Error && error.message.includes('FLUX_PASS'); }
check('live-проверка без пароля останавливается с подсказкой', missingPassRejected);

let blankUserRejected = false;
try { testCredentials({ FLUX_USER: '  ', FLUX_PASS: 'synthetic-password' }); }
catch { blankUserRejected = true; }
check('пустой после пробелов логин не принимается', blankUserRejected);

const credentials = testCredentials({ FLUX_USER: ' test.user ', FLUX_PASS: 'synthetic-password' });
check('заданные параметры возвращаются с очищенным логином', credentials.symbol === 'test.user' && credentials.password === 'synthetic-password');

console.log(`✓ ${passed} проверок testCredentials`);
