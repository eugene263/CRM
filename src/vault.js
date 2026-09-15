// Сейф доступів: видача під розписку, часові доступи, апрув на чутливі
// категорії, ліміт розкриттів на добу і one-click офбординг.
//
// Правило, на якому все тримається: секрет ніколи не їде в списку — лише
// поштучним запитом, і кожен такий запит лишає слід в аудиті.
import { all, get, run, insert, update, audit } from './db.js';
import { decrypt, totpCode } from './crypto.js';
import { capable, revealLimit } from './rbac.js';
import { notify } from './telegram.js';

const SECRET_FIELDS = ['password_enc', 'recovery_enc', 'totp_seed_enc', 'notes_enc'];
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

export const activeGrant = async (credentialId, userId) => get(
  `SELECT * FROM credential_grants WHERE credential_id=? AND user_id=? AND status='active'`, credentialId, userId);

export const validApproval = async (credentialId, userId) => get(
  `SELECT * FROM access_requests WHERE credential_id=? AND user_id=? AND status='approved'
     AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))`, credentialId, userId);

export async function revealsToday(userId) {
  const row = await get(
    `SELECT COUNT(*) AS c FROM audit_log WHERE user_id=? AND action='reveal' AND date(created_at)=date('now')`, userId);
  return Number(row?.c || 0);
}

// Добовий ліміт розкриттів діє на всі секрети CRM, не лише на сейф:
// пароль акаунта чи проксі зливається так само легко, як пароль картки.
export async function checkRevealBudget(user) {
  const limit = revealLimit(user);
  const used = await revealsToday(user.id);
  if (used >= limit) throw Object.assign(new Error(`Ліміт розкриттів на добу вичерпано (${limit})`), { status: 429 });
  return { used, limit };
}

export async function noteReveal(user) { await detectMassReveal(user); }

// Чому доступ дозволено або ні — однією функцією, щоб UI і API не розʼїхались.
export async function canReveal(user, cred) {
  if (!cred) return { ok: false, reason: 'Запис не знайдено', status: 404 };
  if (!capable(user, 'secrets')) return { ok: false, reason: 'Роль не має права розкривати секрети', status: 403 };
  if (cred.status === 'retired') return { ok: false, reason: 'Доступ списаний', status: 403 };

  const isOwner = cred.owner_user_id === user.id;
  const isHolder = cred.holder_user_id === user.id;
  const isAdmin = capable(user, 'settings');

  if (cred.sensitivity === 'sensitive' && !isAdmin && !(await validApproval(cred.id, user.id))) {
    return { ok: false, reason: 'Чутлива категорія: потрібен апрув тімліда або хеда', status: 403, needApproval: true };
  }
  if (!isAdmin && !isOwner && !isHolder && !(await activeGrant(cred.id, user.id))) {
    return { ok: false, reason: 'Доступ вам не виданий — запросіть видачу', status: 403, needGrant: true };
  }
  const limit = revealLimit(user);
  const used = await revealsToday(user.id);
  if (used >= limit) return { ok: false, reason: `Ліміт розкриттів на добу вичерпано (${limit})`, status: 429 };
  return { ok: true, used, limit };
}

export async function reveal(user, credentialId, field, ip) {
  if (!SECRET_FIELDS.includes(field)) throw Object.assign(new Error('Невідоме поле'), { status: 400 });
  const cred = await get('SELECT * FROM credentials WHERE id=?', credentialId);
  const verdict = await canReveal(user, cred);
  if (!verdict.ok) {
    await audit({ user_id: user.id, action: 'denied_reveal', entity: 'credentials', entity_id: credentialId, payload: { field, reason: verdict.reason }, ip });
    throw Object.assign(new Error(verdict.reason), { status: verdict.status, needApproval: verdict.needApproval, needGrant: verdict.needGrant });
  }
  await audit({ user_id: user.id, action: 'reveal', entity: 'credentials', entity_id: credentialId, payload: { field }, ip });
  await detectMassReveal(user);
  return { value: decrypt(cred[field]), used: verdict.used + 1, limit: verdict.limit };
}

// Код 2FA генеруємо самі: сід не виходить із сейфа.
export async function totp(user, credentialId, ip) {
  const cred = await get('SELECT * FROM credentials WHERE id=?', credentialId);
  const verdict = await canReveal(user, cred);
  if (!verdict.ok) throw Object.assign(new Error(verdict.reason), { status: verdict.status });
  const seed = decrypt(cred?.totp_seed_enc);
  if (!seed) throw Object.assign(new Error('Для цього доступу не збережений 2FA seed'), { status: 404 });
  await audit({ user_id: user.id, action: 'reveal', entity: 'credentials', entity_id: credentialId, payload: { field: 'totp_code' }, ip });
  return { code: totpCode(seed), valid_seconds: 30 - (Math.floor(Date.now() / 1000) % 30) };
}

// Антизлив: сплеск розкриттів за годину — привід розбудити власника.
export async function detectMassReveal(user) {
  const lastHour = Number(await get(
    `SELECT COUNT(*) AS c FROM audit_log WHERE user_id=? AND action='reveal'
       AND created_at >= datetime('now','-1 hour')`, user.id)?.c || 0);
  if (lastHour === 10 || lastHour === 25 || lastHour === 50) {
    await notify('security', `🚨 ${user.name} розкрив ${lastHour} секретів за годину`);
  }
}

export async function issue(actor, credentialId, { user_id, due_at = null, state_out = null, note = null }, ip) {
  const cred = await get('SELECT * FROM credentials WHERE id=?', credentialId);
  if (!cred) throw Object.assign(new Error('Доступ не знайдено'), { status: 404 });
  if (!user_id) throw Object.assign(new Error('Не вказано, кому видати'), { status: 400 });
  if (await get(`SELECT id FROM credential_grants WHERE credential_id=? AND status='active'`, credentialId)) {
    throw Object.assign(new Error('Доступ уже на руках — спершу поверніть або відкличте'), { status: 409 });
  }
  const id = await insert('credential_grants', { credential_id: credentialId, user_id, granted_by: actor.id, due_at, state_out, note });
  await update('credentials', credentialId, { holder_user_id: user_id, status: 'issued' });
  await audit({ user_id: actor.id, action: 'credential_issue', entity: 'credentials', entity_id: credentialId, payload: { to: user_id, due_at }, ip });
  await notify('access', `🪪 Виданий доступ «${cred.title}»${due_at ? ` до ${due_at}` : ''}`, user_id);
  return { grant_id: id };
}

// Повернення завжди ставить прапорець ротації: пароль бачила ще одна людина.
export async function returnBack(actor, credentialId, { state_in = null } = {}, ip) {
  const grant = await get(`SELECT * FROM credential_grants WHERE credential_id=? AND status='active'`, credentialId);
  if (!grant) throw Object.assign(new Error('Активної видачі немає'), { status: 404 });
  await update('credential_grants', grant.id, { status: 'returned', returned_at: now(), state_in });
  await update('credentials', credentialId, { holder_user_id: null, status: 'returned', rotate_required: 1 });
  await audit({ user_id: actor.id, action: 'credential_return', entity: 'credentials', entity_id: credentialId, payload: { grant: grant.id }, ip });
  return { ok: true, rotate_required: true };
}

export async function revoke(actor, credentialId, reason, ip) {
  const grant = await get(`SELECT * FROM credential_grants WHERE credential_id=? AND status='active'`, credentialId);
  if (grant) await update('credential_grants', grant.id, { status: 'revoked', returned_at: now(), note: reason || null });
  await update('credentials', credentialId, { holder_user_id: null, status: 'compromised', rotate_required: 1 });
  await audit({ user_id: actor.id, action: 'credential_revoke', entity: 'credentials', entity_id: credentialId, payload: { reason }, ip });
  return { ok: true };
}

export async function requestAccess(user, { credential_id, reason, hours = 8 }) {
  const cred = await get('SELECT * FROM credentials WHERE id=?', credential_id);
  if (!cred) throw Object.assign(new Error('Доступ не знайдено'), { status: 404 });
  const id = await insert('access_requests', {
    credential_id, user_id: user.id, reason,
    expires_at: new Date(Date.now() + Math.min(Number(hours) || 8, 72) * 3600e3).toISOString().slice(0, 19).replace('T', ' '),
  });
  const approvers = await all(`SELECT id FROM users WHERE role IN ('owner','head','teamlead') AND status='active'`);
  for (const a of approvers) await notify('access', `🙋 ${user.name} просить доступ «${cred.title}»: ${reason || '—'}`, a.id);
  return { id };
}

export async function decideAccess(actor, requestId, approve, ip) {
  const req = await get('SELECT * FROM access_requests WHERE id=?', requestId);
  if (!req || req.status !== 'pending') throw Object.assign(new Error('Запит не знайдено або вже опрацьований'), { status: 404 });
  await update('access_requests', requestId, {
    status: approve ? 'approved' : 'rejected', decided_by: actor.id, decided_at: now(),
  });
  await audit({ user_id: actor.id, action: approve ? 'access_approved' : 'access_rejected', entity: 'access_requests', entity_id: requestId, ip });
  await notify('access', approve ? '✅ Ваш запит на доступ схвалено' : '⛔️ Ваш запит на доступ відхилено', req.user_id);
  return { ok: true };
}

// Звільнення однією дією: сесії вбиті, доступи відкликані, паролі — на ротацію.
export async function offboard(actor, userId, ip) {
  const target = await get('SELECT * FROM users WHERE id=?', userId);
  if (!target) throw Object.assign(new Error('Користувача не знайдено'), { status: 404 });
  if (target.role === 'owner') throw Object.assign(new Error('Власника не можна офбордити через CRM'), { status: 403 });

  const grants = await all(`SELECT * FROM credential_grants WHERE user_id=? AND status='active'`, userId);
  for (const g of grants) {
    await update('credential_grants', g.id, { status: 'revoked', returned_at: now(), note: 'offboarding' });
    await update('credentials', g.credential_id, { holder_user_id: null, status: 'compromised', rotate_required: 1 });
  }
  await run(`UPDATE access_requests SET status='expired' WHERE user_id=? AND status IN ('pending','approved')`, userId);
  await run('DELETE FROM sessions WHERE user_id=?', userId);
  await run(`UPDATE users SET status='disabled' WHERE id=?`, userId);
  await run(`UPDATE devices SET status='free', holder_user_id=NULL WHERE holder_user_id=?`, userId);

  await audit({ user_id: actor.id, action: 'offboard', entity: 'users', entity_id: userId, payload: { revoked: grants.length }, ip });
  await notify('security', `👋 Офбординг: ${target.name}. Відкликано доступів: ${grants.length}, усі вони потребують ротації.`);
  return { revoked: grants.length, rotate_required: grants.map((g) => g.credential_id) };
}

// Фонова перевірка: протерміновані видачі й апруви.
export async function expireOverdue() {
  const overdue = await all(
    `SELECT g.*, c.title FROM credential_grants g JOIN credentials c ON c.id=g.credential_id
      WHERE g.status='active' AND g.due_at IS NOT NULL AND datetime(g.due_at) < datetime('now')`);
  for (const g of overdue) {
    await update('credential_grants', g.id, { status: 'expired' });
    await update('credentials', g.credential_id, { holder_user_id: null, status: 'compromised', rotate_required: 1 });
    await notify('access', `⌛️ Час доступу «${g.title}» вичерпано — відкликано автоматично`, g.user_id);
  }
  await run(`UPDATE access_requests SET status='expired'
        WHERE status IN ('pending','approved') AND expires_at IS NOT NULL AND datetime(expires_at) < datetime('now')`);
  return { expired: overdue.length };
}
