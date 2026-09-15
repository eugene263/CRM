// Автентифікація: email+пароль (+ TOTP-2FA), сесії в БД, httpOnly-кука.
import { all, get, insert, run, audit } from './db.js';
import { hashPassword, verifyPassword, token, verifyTotp, totpSecret } from './crypto.js';
import { clientIp, cookies } from './http.js';

const SESSION_DAYS = Number(process.env.CRM_SESSION_DAYS || 7);
export const COOKIE = 'crm_session';

export function login({ email, password, totp, ip, userAgent }) {
  const user = get('SELECT * FROM users WHERE lower(email)=lower(?)', String(email || '').trim());
  if (!user || user.status !== 'active' || !verifyPassword(password, user.password_hash)) {
    audit({ action: 'login_failed', entity: 'users', payload: { email }, ip });
    return { error: 'Невірний email або пароль' };
  }
  if (user.totp_secret && !verifyTotp(user.totp_secret, totp)) {
    audit({ user_id: user.id, action: 'login_failed_2fa', entity: 'users', entity_id: user.id, ip });
    return { error: 'Невірний код 2FA', need2fa: true };
  }
  const t = token();
  insert('sessions', {
    token: t, user_id: user.id, ip, user_agent: String(userAgent || '').slice(0, 300),
    expires_at: new Date(Date.now() + SESSION_DAYS * 864e5).toISOString(),
  });
  audit({ user_id: user.id, action: 'login', entity: 'users', entity_id: user.id, ip });
  return { token: t, user: publicUser(user) };
}

export function logout(t, userId, ip) {
  run('DELETE FROM sessions WHERE token=?', t);
  audit({ user_id: userId, action: 'logout', ip });
}

export function userFromRequest(req) {
  const jar = cookies(req);
  const header = String(req.headers.authorization || '');
  const t = jar[COOKIE] || (header.startsWith('Bearer ') ? header.slice(7) : null);
  if (!t) return null;
  const session = get('SELECT * FROM sessions WHERE token=?', t);
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    run('DELETE FROM sessions WHERE token=?', t);
    return null;
  }
  const user = get('SELECT * FROM users WHERE id=?', session.user_id);
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

export function setPassword(userId, password) {
  run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(password), userId);
}

export function enable2fa(userId) {
  const secret = totpSecret();
  run('UPDATE users SET totp_secret=? WHERE id=?', secret, userId);
  const user = get('SELECT email FROM users WHERE id=?', userId);
  return { secret, uri: `otpauth://totp/GennectCRM:${encodeURIComponent(user.email)}?secret=${secret}&issuer=GennectCRM` };
}

export function disable2fa(userId) {
  run('UPDATE users SET totp_secret=NULL WHERE id=?', userId);
}

export function sessionsOf(userId) {
  return all('SELECT token, ip, user_agent, created_at, expires_at FROM sessions WHERE user_id=?', userId);
}

export { clientIp };
