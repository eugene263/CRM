// Криптографія: хеш паролів співробітників (scrypt) та шифрування секретів
// ресурсів (AES-256-GCM). Ключ береться з CRM_SECRET_KEY і ніколи не лежить у БД.
import crypto from 'node:crypto';

const KEY_ENV = process.env.CRM_SECRET_KEY || '';

function masterKey() {
  if (!KEY_ENV) {
    // dev-режим: детермінований ключ, щоб локальна база відкривалась між рестартами.
    // У проді CRM_SECRET_KEY обовʼязковий — див. server.js (warn при старті).
    return crypto.createHash('sha256').update('gennect-crm-dev-key').digest();
  }
  if (/^[0-9a-f]{64}$/i.test(KEY_ENV)) return Buffer.from(KEY_ENV, 'hex');
  return crypto.createHash('sha256').update(KEY_ENV).digest();
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, saltHex, hashHex] = stored.split('$');
  const hash = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

export function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

export function decrypt(payload) {
  if (!payload) return null;
  const parts = String(payload).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(parts[1], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const hashIp = (ip) => crypto.createHash('sha256').update(String(ip || '')).digest('hex').slice(0, 32);

// TOTP (RFC 6238), сумісний з Google Authenticator / Authy.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function totpSecret() {
  const buf = crypto.randomBytes(20);
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function b32decode(secret) {
  let bits = '';
  for (const ch of secret.toUpperCase().replace(/=+$/, '')) {
    const idx = B32.indexOf(ch);
    if (idx >= 0) bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totpCode(secret, counter = Math.floor(Date.now() / 30000)) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', b32decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % 1e6).padStart(6, '0');
}

export function verifyTotp(secret, code, window = 1) {
  if (!secret) return true;              // 2FA не увімкнено для користувача
  const now = Math.floor(Date.now() / 30000);
  for (let i = -window; i <= window; i++) {
    if (totpCode(secret, now + i) === String(code || '').trim()) return true;
  }
  return false;
}
