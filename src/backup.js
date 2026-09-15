// Добова копія БД.
// SQLite: VACUUM INTO — консистентний знімок навіть під записом.
// Postgres: копії робить провайдер (Railway/RDS); дублювати їх з процесу
// застосунку означало б тримати другу копію даних поруч із першою.
import fs from 'node:fs';
import path from 'node:path';
import { engine, dbFile, setting } from './db.js';

const KEEP = Number(process.env.CRM_BACKUP_KEEP || 14);

export async function backupDatabase({ force = false } = {}) {
  if (engine !== 'sqlite') return { skipped: 'postgres: бекапи на боці провайдера' };
  const today = new Date().toISOString().slice(0, 10);
  if (!force && (await setting('last_backup')) === today) return { skipped: true };

  const { raw } = await import('./db-sqlite.js');
  const dir = process.env.CRM_BACKUP_DIR || path.join(path.dirname(dbFile), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `crm-${today}.db`);
  if (fs.existsSync(target)) fs.rmSync(target);
  raw.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  await setting('last_backup', today);

  const stale = fs.readdirSync(dir).filter((f) => /^crm-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse().slice(KEEP);
  for (const f of stale) fs.rmSync(path.join(dir, f), { force: true });
  return { file: target, kept: KEEP };
}
