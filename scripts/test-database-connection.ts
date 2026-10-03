/** Проверка безопасного сохранения строки общей базы до запуска сервера. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveDatabaseConfig, saveLocalDatabasePathConfig, validateDatabaseUri } from '../electron/connectionConfig';

let ok = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) ok++;
  else { fail++; console.log(`✗ ${name}\n   получено: ${JSON.stringify(got)}\n   ожидалось: ${JSON.stringify(want)}`); }
};
const accepted = [
  'mysql://demo:dummy%40pass@db.example.test:3306/flux_demo',
  'mariadb://demo:dummy%25pass@db.example.test/flux_demo',
  'postgresql://demo:dummy%3Apass@db.example.test:5432/flux_demo',
];
const rejected = [
  'https://db.example.test/flux_demo',
  'mysql://demo@/flux_demo',
  'mysql://demo@db.example.test/',
  'mysql://demo@db.example.test:0/flux_demo',
  'mysql://demo@db.example.test:65536/flux_demo',
  'mysql://demo@db.example.test:abc/flux_demo',
  'mysql://demo@db.example.test/one/two',
  'mysql://demo@db.example.test/one%2Ftwo',
  'mysql://demo@db.example.test/flux_demo#fragment',
  'mysql://demo@db.example.test/flux_demo\\other',
  'mysql://demo:bad%escape@db.example.test/flux_demo',
  'sqlite:///tmp/flux.db',
];
accepted.forEach((uri, i) => eq(`допустимый URI №${i + 1} сохраняет исходную запись`, validateDatabaseUri(uri), uri));
rejected.forEach((uri, i) => eq(`недопустимый URI №${i + 1} отклоняется`, validateDatabaseUri(uri), null));

aSync();
function aSync() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-db-config-test-'));
  const configPath = path.join(dir, 'config.json');
  try {
    const original = {
      current_db_type: 'LOCAL', local_db_path: 'custom/database.sqlite', remote_server_url: 'https://old.example.test',
      display: { monitor: 2, bounds: [10, 20, 900, 700] }, keep: ['one', 'two'],
    };
    fs.writeFileSync(configPath, JSON.stringify(original));
    saveDatabaseConfig(configPath, accepted[0]);
    const remote = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const backup = JSON.parse(fs.readFileSync(`${configPath}.bak`, 'utf8'));
    eq('общая база задаёт REMOTE и очищает старый сервер', [remote.current_db_type, remote.remote_server_url], ['REMOTE', '']);
    eq('сохраняются путь локальной базы и прочие настройки', [remote.local_db_path, remote.display, remote.keep], [original.local_db_path, original.display, original.keep]);
    eq('резервная копия содержит прежнюю конфигурацию', backup, original);

    saveDatabaseConfig(configPath, '');
    const local = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    eq('пустая строка совместимо возвращает LOCAL и сохраняет путь', [local.current_db_type, local.database_url, local.local_db_path], ['LOCAL', '', original.local_db_path]);

    saveLocalDatabasePathConfig(configPath, path.join(dir, 'replacement.sqlite'));
    const replacement = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    eq('путь, выбранный через IPC, переключает на локальную базу и сохраняет прочие настройки',
      [replacement.current_db_type, replacement.database_url, replacement.local_db_path, replacement.display, replacement.keep],
      ['LOCAL', '', path.join(dir, 'replacement.sqlite'), original.display, original.keep]);

    const malformed = '{broken config';
    fs.writeFileSync(configPath, malformed);
    let threw = false;
    try { saveDatabaseConfig(configPath, accepted[0]); } catch { threw = true; }
    eq('повреждённая конфигурация отклоняется', threw, true);
    eq('при повреждённом JSON исходные байты не меняются', fs.readFileSync(configPath, 'utf8'), malformed);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${ok} проверок пройдено, ${fail} провалено`);
  process.exit(fail ? 1 : 0);
}
