// Перший запуск на порожній базі: створюємо власника з env, щоб було під ким
// зайти. Пароль не генеруємо мовчки — інакше він осідає лише в логах хостингу.
import { get, insert } from './db.js';
import { hashPassword } from './crypto.js';

export function bootstrapOwner() {
  if (get('SELECT id FROM users LIMIT 1')) return null;
  const email = process.env.CRM_ADMIN_EMAIL;
  const password = process.env.CRM_ADMIN_PASSWORD;
  if (!email || !password) {
    console.warn('⚠️  База порожня, а CRM_ADMIN_EMAIL/CRM_ADMIN_PASSWORD не задані — увійти нікому.');
    console.warn('   Задайте змінні й перезапустіть, або виконайте: node src/seed.js --admin');
    return null;
  }
  const id = insert('users', {
    email, name: process.env.CRM_ADMIN_NAME || 'Власник', role: 'owner',
    password_hash: hashPassword(password), status: 'active',
  });
  console.log(`Створено власника: ${email}`);
  return id;
}
