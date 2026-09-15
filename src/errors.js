// Мінімальний репортер помилок у Sentry без SDK: одна подія — один POST.
// Без CRM_SENTRY_DSN просто пише в лог, тому в дев-режимі нічого не тече.
const DSN = process.env.CRM_SENTRY_DSN || '';
const ENV = process.env.CRM_ENV || (process.env.CRM_DATABASE_URL ? 'production' : 'development');

function parseDsn(dsn) {
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace('/', '');
    return {
      url: `${url.protocol}//${url.host}/api/${projectId}/store/`,
      key: url.username,
    };
  } catch { return null; }
}

const target = DSN ? parseDsn(DSN) : null;

export async function captureError(error, context = {}) {
  console.error('[error]', error?.stack || error, Object.keys(context).length ? context : '');
  if (!target) return { skipped: true };
  try {
    await fetch(target.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${target.key}, sentry_client=gennect-crm/1.0`,
      },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        platform: 'node',
        environment: ENV,
        level: 'error',
        logger: context.logger || 'crm',
        message: String(error?.message || error).slice(0, 500),
        exception: {
          values: [{
            type: error?.name || 'Error',
            value: String(error?.message || error).slice(0, 500),
            stacktrace: { frames: framesOf(error) },
          }],
        },
        tags: { route: context.route || null, engine: process.env.CRM_DATABASE_URL ? 'postgres' : 'sqlite' },
        extra: context,
      }),
    });
    return { sent: true };
  } catch (e) {
    console.error('[sentry] не вдалося надіслати:', e.message);
    return { failed: true };
  }
}

function framesOf(error) {
  return String(error?.stack || '').split('\n').slice(1, 12).reverse().map((line) => {
    const m = line.match(/at (.+) \((.+):(\d+):(\d+)\)/) || line.match(/at (.+):(\d+):(\d+)/);
    if (!m) return { function: line.trim() };
    return m.length === 5
      ? { function: m[1], filename: m[2], lineno: Number(m[3]), colno: Number(m[4]) }
      : { filename: m[1], lineno: Number(m[2]), colno: Number(m[3]) };
  });
}

// Падіння процесу теж має долітати до Sentry, інакше сплески 500-х
// видно лише в логах хостингу.
export function installGlobalHandlers() {
  process.on('uncaughtException', (e) => { captureError(e, { logger: 'uncaughtException' }); });
  process.on('unhandledRejection', (e) => { captureError(e, { logger: 'unhandledRejection' }); });
}
