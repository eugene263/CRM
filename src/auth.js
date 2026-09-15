// Автентифікація: email+пароль (+ TOTP-2FA), сесії в БД, httpOnly-кука.
import { all, get, insert, run, audit } from './db.js';
import { hashPassword, verifyPassword, token, verifyTotp, totpSecret } from './crypto.js';
import { clientIp, cookies } from './http.js';

const SESSION_DAYS = Number(process.env.CRM_SESSION_DAYS || 7);
export const COOKIE = 'crm_session';

export async function login({ email, password, totp, ip, userAgent }) {
  const user = await get('SELECT * FROM users WHERE lower(email)=lower(?)', String(email || '').trim());
  if (!user || user.status !== 'active' || !verifyPassword(password, user.password_hash)) {
    await audit({ action: 'login_failed', entity: 'users', payload: { email }, ip });
    return { error: 'Невірний email або пароль' };
  }
  if (user.totp_secret && !verifyTotp(user.totp_secret, totp)) {
    await audit({ user_id: user.id, action: 'login_failed_2fa', entity: 'users', entity_id: user.id, ip });
    return { error: 'Невірний код 2FA', need2fa: true };
  }
  const t = token();
  await insert('sessions', {
    token: t, user_id: user.id, ip, user_agent: String(userAgent || '').slice(0, 300),
    expires_at: new Date(Date.now() + SESSION_DAYS * 864e5).toISOString(),
  });
  await audit({ user_id: user.id, action: 'login', entity: 'users', entity_id: user.id, ip });
  return { token: t, user: publicUser(user) };
}

export async function logout(t, userId, ip) {
  await run('DELETE FROM sessions WHERE token=?', t);
  await audit({ user_id: userId, action: 'logout', ip });
}

export async function userFromRequest(req) {
  const jar = cookies(req);
  const header = String(req.headers.authorization || '');
  const t = jar[COOKIE] || (header.startsWith('Bearer ') ? header.slice(7) : null);
  if (!t) return null;
  const session = await get('SELECT * FROM sessions WHERE token=?', t);
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    await run('DELETE FROM sessions WHERE token=?', t);
    return null;
  }
  const user = await get('SELECT * FROM users WHERE id=?', session.user_id);
  if (!user || user.status !== 'active') return null;
  user.session_token = t;
  return user;
}

export const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, role: u.role, team_id: u.team_id,
  telegram_id: u.telegram_id, has_2fa: !!u.totp_secret,
});

export function sessionCookie(t, maxAgeDays = SESSION_DAYS) {
  const secure = process.env.CRM_SECURE_COOKIE === '1' ? '; Secure' : '';
  return `${COOKIE}=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeDays * 86400}${secure}`;
}

export const clearCookie = () => `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;

export async function setPassword(userId, password) {
  await run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(password), userId);
}

export async function enable2fa(userId) {
  const secret = totpSecret();
  await run('UPDATE users SET totp_secret=? WHERE id=?', secret, userId);
  const user = await get('SELECT email FROM users WHERE id=?', userId);
  return { secret, uri: `otpauth://totp/GennectCRM:${encodeURIComponent(user.email)}?secret=${secret}&issuer=GennectCRM` };
}

export async function disable2fa(userId) {
  await run('UPDATE users SET totp_secret=NULL WHERE id=?', userId);
}

// Примусове завершення сесії: тільки своєї (чужі — через офбординг).
export async function killSession(userId, token) {
  return Number((await run('DELETE FROM sessions WHERE user_id=? AND token=?', userId, token)).changes);
}

export async function sessionsOf(userId) {
  return await all('SELECT token, ip, user_agent, created_at, expires_at FROM sessions WHERE user_id=?', userId);
}

export { clientIp };
