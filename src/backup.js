// Добова копія БД. Том — це не бекап, але копія з ротацією на тому рятує
// від «видалив не те» і від зіпсованого запису; зовнішній бекап — окремо
// (див. README, розділ «Бекапи»).
import fs from 'node:fs';
import path from 'node:path';
import { db, dbFile, setting } from './db.js';

const KEEP = Number(process.env.CRM_BACKUP_KEEP || 14);

export function backupDatabase({ force = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  if (!force && setting('last_backup') === today) return { skipped: true };
  const dir = process.env.CRM_BACKUP_DIR || path.join(path.dirname(dbFile), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `crm-${today}.db`);
  // VACUUM INTO дає консистентний знімок навіть під час запису, на відміну
  // від простого копіювання файлу з WAL.
  if (fs.existsSync(target)) fs.rmSync(target);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  setting('last_backup', today);

  const stale = fs.readdirSync(dir).filter((f) => /^crm-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse().slice(KEEP);
  for (const f of stale) fs.rmSync(path.join(dir, f), { force: true });
  return { file: target, kept: KEEP };
}
