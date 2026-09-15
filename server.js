// Точка входу: адмінка + API (порт CRM_PORT) і окремий легкий сервіс постбеків
// (порт CRM_POSTBACK_PORT) — щоб сплеск конверсій не клав інтерфейс.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi, handleRedirect, handlePostback } from './src/api.js';
import { fail, send } from './src/http.js';
import { flushQueue, runChecks } from './src/telegram.js';
import { dbFile } from './src/db.js';
import { bootstrapOwner } from './src/bootstrap.js';
import { migrate } from './src/migrate.js';
import { seedRoles, syncNewEntities } from './src/rbac.js';
import { expireOverdue } from './src/vault.js';
import { backupDatabase } from './src/backup.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, 'public');
// На PaaS (Railway/Render/Fly) назовні видно рівно один порт — його дає PORT.
// Тоді постбеки обслуговує основний процес (той самий /pb і /r), а окремий
// лістенер не піднімається: CRM_POSTBACK_PORT=0 вимикає його явно.
const PORT = Number(process.env.CRM_PORT || process.env.PORT || 3000);
const PB_PORT = process.env.CRM_POSTBACK_PORT !== undefined
  ? Number(process.env.CRM_POSTBACK_PORT)
  : (process.env.PORT ? 0 : PORT + 1);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, 'Not found');
  }
  const body = fs.readFileSync(file);
  send(res, 200, body, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-cache',
    'content-security-policy': "default-src 'self'; img-src 'self' data: https:; media-src 'self' https:; style-src 'self' 'unsafe-inline'",
  });
}

const app = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/r/')) return handleRedirect(req, res, url);
    if (url.pathname.startsWith('/pb/')) return handlePostback(req, res, url);
    if (url.pathname === '/health') return send(res, 200, { ok: true });
    return serveStatic(req, res, url);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('[crm]', e);
    // Підказки для інтерфейсу: чому саме відмовлено — щоб показати кнопку
    // «запросити доступ», а не просто червоний тост.
    const hints = {};
    for (const key of ['needApproval', 'needGrant', 'need2fa']) if (e[key]) hints[key] = true;
    return fail(res, status, e.message || 'Внутрішня помилка', hints);
  }
});

const postbackApp = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/pb/')) return handlePostback(req, res, url);
    if (url.pathname.startsWith('/r/')) return handleRedirect(req, res, url);
    if (url.pathname === '/health') return send(res, 200, { ok: true });
    return send(res, 404, 'Not found');
  } catch (e) {
    console.error('[postback]', e);
    return fail(res, e.status || 500, e.message || 'error');
  }
});

migrate();
seedRoles();
syncNewEntities();
bootstrapOwner();

if (process.env.CRM_ROLE !== 'postback') {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`CRM:      http://localhost:${PORT}`);
    console.log(`БД:       ${dbFile}`);
    if (!process.env.CRM_SECRET_KEY) console.warn('⚠️  CRM_SECRET_KEY не заданий — секрети шифруються dev-ключем. Для проду задайте 32-байтовий hex.');
  });
}
if (PB_PORT > 0) {
  postbackApp.listen(PB_PORT, '0.0.0.0', () => console.log(`Postback: http://localhost:${PB_PORT}/pb/<token>`));
} else {
  console.log('Postback: обслуговується основним процесом на /pb/<token>');
}

// Фонові перевірки й розсилка (аналог BullMQ-воркера на малому масштабі).
const tick = async () => {
  try {
    runChecks();
    expireOverdue();       // протерміновані видачі доступів
    backupDatabase();      // добова копія бази поруч із самою базою на томі
    await flushQueue();
  } catch (e) { console.error('[worker]', e.message); }
};
setInterval(tick, Number(process.env.CRM_TICK_MS || 15 * 60_000)).unref();
setTimeout(tick, 5_000).unref();
