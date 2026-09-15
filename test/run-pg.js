// Прогін того самого набору тестів проти чистої бази Postgres.
// Потрібен доступний сервер PG; URL береться з CRM_PG_ADMIN_URL.
import { spawnSync } from 'node:child_process';
import pg from 'pg';

const adminUrl = process.env.CRM_PG_ADMIN_URL || 'postgres://postgres:pgpass@127.0.0.1:5432/postgres';
const dbName = `crm_test_${Date.now()}`;

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`CREATE DATABASE ${dbName}`);
await admin.end();

const testUrl = adminUrl.replace(/\/[^/]*$/, `/${dbName}`);
const res = spawnSync(process.execPath, ['--test', 'test/smoke.test.js'], {
  stdio: 'inherit',
  env: { ...process.env, CRM_TEST_DATABASE_URL: testUrl },
});

const cleanup = new pg.Client({ connectionString: adminUrl });
await cleanup.connect();
await cleanup.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
await cleanup.end();

process.exit(res.status ?? 1);
