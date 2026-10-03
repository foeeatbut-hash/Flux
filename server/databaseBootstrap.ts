import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ensureRemoteSchema, parsePrismaSchema } from './schema-sync.js';
import { ensureSchemaColumns } from './localSchema.js';
import { assertHealthySqlite } from './sqliteSafety.js';

const require = createRequire(__filename);

export interface LocalDatabaseBootstrapResult {
  created: boolean;
  applied: string[];
}

/**
 * Create a clean local database when none exists, then build its schema from
 * the packaged Prisma schema. Existing files are validated and preserved.
 */
export async function bootstrapLocalDatabase(
  dbPath: string,
  prisma: any,
  schemaText: string,
  log: (message: string) => void,
  options: { alreadyCreatedEmpty?: boolean } = {},
): Promise<LocalDatabaseBootstrapResult> {
  const created = options.alreadyCreatedEmpty === true || !fs.existsSync(dbPath);
  if (created) {
    if (!fs.existsSync(dbPath)) {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const Database = require('better-sqlite3');
      const db = new Database(dbPath);
      db.close();
    }
    log('[SQLite Bootstrap] Создана новая пустая база; структура будет построена из схемы Flux.');
  } else {
    // Never replace or repair an existing file implicitly.
    assertHealthySqlite(dbPath);
  }

  const applied = await ensureRemoteSchema(prisma, 'sqlite', schemaText, log);
  const models = parsePrismaSchema('sqlite', schemaText);
  const Database = require('better-sqlite3');
  const check = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const existing = new Set((check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name));
    const missing = models.map(model => model.name).filter(name => !existing.has(name));
    if (missing.length) throw new Error(`Не удалось создать локальную схему (${missing.length} таблиц отсутствуют).`);
  } finally {
    check.close();
  }

  ensureSchemaColumns(dbPath, log);
  assertHealthySqlite(dbPath);
  return { created, applied };
}

/** Create a valid empty SQLite container without reading or copying a template. */
export function createEmptyLocalDatabase(dbPath: string): boolean {
  if (fs.existsSync(dbPath)) return false;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.close();
  return true;
}
