// Демо-дані: команда, ресурси, офери, 30 днів заливів і конверсій.
// node src/seed.js            — наповнити демо-даними
// node src/seed.js --admin    — створити лише власника (для продакшн-старту)
import { all, get, insert, run, close, initSchema } from './db.js';
import { hashPassword, encrypt, token } from './crypto.js';

const ADMIN_EMAIL = process.env.CRM_ADMIN_EMAIL || 'owner@gennect.local';
const ADMIN_PASSWORD = process.env.CRM_ADMIN_PASSWORD || 'gennect-admin';

const rnd = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[rnd(0, arr.length - 1)];
const day = (offset) => new Date(Date.now() - offset * 864e5).toISOString().slice(0, 10);
const stamp = (offset) => `${day(offset)} ${String(rnd(8, 23)).padStart(2, '0')}:${String(rnd(0, 59)).padStart(2, '0')}:00`;

async function ensureAdmin() {
  const existing = await get('SELECT id FROM users WHERE lower(email)=lower(?)', ADMIN_EMAIL);
  if (existing) return existing.id;
  const id = await insert('users', {
    email: ADMIN_EMAIL, name: 'Власник', role: 'owner',
    password_hash: hashPassword(ADMIN_PASSWORD), status: 'active',
  });
  console.log(`Створено власника: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
  return id;
}

async function seedDemo() {
  if (await get('SELECT id FROM accounts LIMIT 1')) {
    console.log('БД уже містить дані — демо-сід пропущено.');
    return;
  }
  const teamA = await insert('teams', { name: 'Team Alpha' });
  const teamB = await insert('teams', { name: 'Team Bravo' });

  const users = [
    { email: 'head@gennect.local', name: 'Хед Дмитро', role: 'head', team_id: null },
    { email: 'lead.a@gennect.local', name: 'Тімлід Аня', role: 'teamlead', team_id: teamA },
    { email: 'lead.b@gennect.local', name: 'Тімлід Богдан', role: 'teamlead', team_id: teamB },
    { email: 'creator1@gennect.local', name: 'Крієйтор Ліза', role: 'creator', team_id: teamA },
    { email: 'creator2@gennect.local', name: 'Крієйтор Макс', role: 'creator', team_id: teamA },
    { email: 'creator3@gennect.local', name: 'Крієйтор Ніка', role: 'creator', team_id: teamB },
    { email: 'editor@gennect.local', name: 'Монтажер Ігор', role: 'editor', team_id: teamA },
    { email: 'farmer@gennect.local', name: 'Фармер Олег', role: 'farmer', team_id: null },
    { email: 'finance@gennect.local', name: 'Фінансист Ольга', role: 'finance', team_id: null },
  ];
  for (const u of users) {
    u.id = await insert('users', { ...u, password_hash: hashPassword('demo1234'), status: 'active' });
  }

  await run('UPDATE teams SET lead_user_id=? WHERE id=?', users[1].id, teamA);
  await run('UPDATE teams SET lead_user_id=? WHERE id=?', users[2].id, teamB);
  const creators = users.filter((u) => u.role === 'creator');

  const partnerIds = [];
  for (const name of ['LuckyPartners', 'AdCombo', 'CryptoLeads']) {
    partnerIds.push(await insert('partners', {
      name, contact: `@${name.toLowerCase()}_manager`, postback_token: token(12), balance: rnd(500, 4000),
      terms: 'Виплати щотижня, холд 7 днів',
    }));
  }

  const offerSpecs = [
    { name: 'Casino X UA', vertical: 'gambling', geo: 'UA', payout: 45, model: 'CPA', hold_days: 7 },
    { name: 'BetPro PL', vertical: 'betting', geo: 'PL', payout: 38, model: 'CPA', hold_days: 14 },
    { name: 'CryptoStart DE', vertical: 'crypto', geo: 'DE', payout: 120, model: 'CPA', hold_days: 21 },
    { name: 'Nutra Slim IT', vertical: 'nutra', geo: 'IT', payout: 22, model: 'CPL', hold_days: 3 },
  ];
  const offers = [];
  for (const [i, o] of offerSpecs.entries()) {
    const id = await insert('offers', {
      ...o, partner_id: partnerIds[i % partnerIds.length], status: 'active',
      landing_url: `https://track.example.com/${o.geo.toLowerCase()}`,
    });
    await insert('offer_rates_history', { offer_id: id, payout: o.payout });
    offers.push({ ...o, id });
  }

  const devices = [];
  for (let i = 0; i < 8; i += 1) {
    devices.push(await insert('devices', {
      model: pick(['iPhone 11', 'iPhone 12', 'Redmi Note 12', 'Samsung A54']),
      imei: String(35000000000000 + i * 137), status: i < 6 ? 'in_use' : 'free',
      holder_user_id: i < 6 ? pick(creators).id : null, issued_at: day(rnd(20, 90)), cost: rnd(120, 400),
    }));
  }
  const sims = [];
  for (const d of devices) {
    sims.push(await insert('sims', {
      number: `+38050${rnd(1000000, 9999999)}`, operator: pick(['Kyivstar', 'Vodafone', 'lifecell']),
      geo: 'UA', device_id: d, status: 'in_use', cost: 3,
    }));
  }
  const proxies = [];
  for (let i = 0; i < 10; i += 1) {
    proxies.push(await insert('proxies', {
      kind: pick(['mobile', 'residential']), geo: pick(['UA', 'PL', 'DE', 'IT']),
      provider: pick(['ProxyLine', 'Astro', 'iProxy']), host: `10.0.${rnd(1, 254)}.${rnd(1, 254)}:8000`,
      credentials_enc: encrypt(`user${rnd(100, 999)}:pass${token(4)}`),
      paid_until: day(-rnd(-2, 25)), cost: rnd(8, 30), status: 'active',
    }));
  }
  const mails = [];
  for (let i = 0; i < 12; i += 1) {
    mails.push(await insert('mail_accounts', {
      login: `farm${i + 1}@firstmail.ltd`, password_enc: encrypt(`mailpass${token(3)}`),
      service: 'firstmail', status: 'active', cost: 0.3,
    }));
  }

  const accounts = [];
  for (let i = 0; i < 28; i += 1) {
    const owner = pick(creators);
    const status = i < 16 ? 'active' : i < 20 ? 'farm' : i < 24 ? 'ban' : pick(['active', 'shadowban']);
    const created = rnd(10, 80);
    const id = await insert('accounts', {
      platform: pick(['tiktok', 'tiktok', 'instagram', 'youtube']),
      nickname: `gen_${token(3).toLowerCase()}_${i}`,
      status, geo: pick(['UA', 'PL', 'DE', 'IT']),
      registered_at: day(created), farm_started_at: day(created), live_started_at: status === 'farm' ? null : day(created - 3),
      banned_at: status === 'ban' ? day(rnd(1, 9)) : null,
      device_id: pick(devices), proxy_id: pick(proxies), sim_id: pick(sims), mail_id: pick(mails),
      owner_user_id: owner.id, team_id: owner.team_id, cost: rnd(3, 25),
      password_enc: encrypt(`acc-${token(4)}`),
    });
    await insert('account_events', { account_id: id, to_status: 'farm', user_id: owner.id, created_at: `${day(created)} 10:00:00` });
    if (status !== 'farm') await insert('account_events', { account_id: id, from_status: 'farm', to_status: 'active', user_id: owner.id, created_at: `${day(created - 3)} 12:00:00` });
    if (status === 'ban') await insert('account_events', { account_id: id, from_status: 'active', to_status: 'ban', user_id: owner.id, created_at: `${day(rnd(1, 9))} 14:00:00` });
    accounts.push({ id, owner, status });
  }

  const creatives = [];
  for (let i = 0; i < 14; i += 1) {
    const offer = pick(offers);
    const author = pick([...creators, users[6]]);
    creatives.push({
      id: await insert('creatives', {
        title: `${offer.vertical}-hook-${i + 1}`, vertical: offer.vertical, offer_id: offer.id, geo: offer.geo,
        hook: pick(['«я зняла це з першої спроби»', 'скрін виплати', 'реакція друга', 'до/після']),
        edit_type: pick(['talking_head', 'slideshow', 'ugc', 'ai']), tags: `${offer.vertical},${offer.geo}`,
        status: i < 9 ? 'live' : pick(['ready', 'burned', 'draft']),
        author_user_id: author.id, team_id: author.team_id,
        file_url: `https://r2.example.com/creatives/${i + 1}.mp4`,
      }),
      offer,
    });
  }

  const liveAccounts = accounts.filter((a) => a.status !== 'farm');
  let posts = 0;
  for (let d = 30; d >= 0; d -= 1) {
    for (const acc of liveAccounts) {
      if (Math.random() > 0.55) continue;
      const cr = pick(creatives);
      const views = rnd(200, 60000);
      const clicks = Math.round(views * (rnd(5, 40) / 1000));
      const postId = await insert('posts', {
        account_id: acc.id, creative_id: cr.id, offer_id: cr.offer.id, user_id: acc.owner.id, team_id: acc.owner.team_id,
        posted_at: stamp(d), url: `https://tiktok.com/@x/video/${rnd(1e6, 9e6)}`,
        views, likes: Math.round(views * 0.06), comments: Math.round(views * 0.004), clicks,
      });
      posts += 1;
      const deps = clicks > 0 && Math.random() < 0.35 ? rnd(1, 3) : 0;
      for (let k = 0; k < deps; k += 1) {
        await insert('conversions', {
          offer_id: cr.offer.id, account_id: acc.id, creative_id: cr.id, user_id: acc.owner.id, post_id: postId,
          partner_id: (await get('SELECT partner_id FROM offers WHERE id=?', cr.offer.id)).partner_id,
          event: 'dep', status: d > 7 ? pick(['approved', 'approved', 'paid', 'rejected']) : 'hold',
          payout: cr.offer.payout, source: 'manual', converted_at: stamp(d),
          external_id: token(8),
        });
      }
      if (clicks > 0 && Math.random() < 0.5) {
        await insert('conversions', {
          offer_id: cr.offer.id, account_id: acc.id, creative_id: cr.id, user_id: acc.owner.id, post_id: postId,
          event: 'reg', status: 'approved', payout: 0, source: 'manual', converted_at: stamp(d), external_id: token(8),
        });
      }
    }
  }

  for (let d = 30; d >= 0; d -= 7) {
    await insert('expenses', { category: 'proxy', amount: rnd(60, 140), spent_at: day(d), note: 'оплата проксі' });
    await insert('expenses', { category: 'accounts', amount: rnd(40, 180), spent_at: day(d), note: 'закупка акаунтів' });
    for (const c of creators) await insert('expenses', { category: 'service', amount: rnd(10, 40), spent_at: day(d), user_id: c.id, team_id: c.team_id, note: 'сервіси/підписки' });
  }

  await insert('salary_rules', { role: 'creator', fix_amount: 300, percent_of_profit: 25, bonus_metric: 'posts', bonus_target: 200, bonus_amount: 100, active_from: day(120) });
  await insert('salary_rules', { role: 'teamlead', fix_amount: 700, percent_of_profit: 10, active_from: day(120) });
  await insert('salary_rules', { role: 'editor', fix_amount: 500, percent_of_profit: 0, bonus_metric: 'posts', bonus_target: 300, bonus_amount: 150, active_from: day(120) });
  await insert('salary_rules', { role: 'farmer', fix_amount: 450, percent_of_profit: 0, active_from: day(120) });

  for (const c of creators) {
    await insert('kpi_targets', { user_id: c.id, period: new Date().toISOString().slice(0, 7), metric: 'posts', target: 200 });
    await insert('kpi_targets', { user_id: c.id, period: day(0), metric: 'posts', target: 10 });
  }

  for (const cr of creatives.slice(0, 6)) {
    await insert('tracking_links', {
      slug: token(6), offer_id: cr.offer.id, creative_id: cr.id, user_id: pick(creators).id,
      target_url: `https://track.example.com/click?offer=${cr.offer.id}`,
    });
  }

  // Сейф: показуємо всі три режими — звичайний, чутливий і з 2FA-сідом.
  const vaultOwner = users[7].id;   // фармер тримає ресурсні доступи
  await insert('credentials', {
    title: 'Firstmail — пул фарму', kind: 'mail', login: 'farm-pool@firstmail.ltd',
    password_enc: encrypt(`mail-${token(5)}`), service: 'firstmail',
    owner_user_id: vaultOwner, status: 'stored',
  });
  await insert('credentials', {
    title: 'Картка для оплати проксі', kind: 'card', login: '4149 **** **** 8830',
    password_enc: encrypt('CVV 341, 09/29'), recovery_enc: encrypt('банк: підтвердження по СМС'),
    sensitivity: 'sensitive', owner_user_id: users[8].id, status: 'stored',
  });
  await insert('credentials', {
    title: 'Кабінет LuckyPartners', kind: 'service', login: 'gennect@partner.io',
    password_enc: encrypt(`pp-${token(5)}`), totp_seed_enc: encrypt('JBSWY3DPEHPK3PXP'),
    sensitivity: 'sensitive', service: 'LuckyPartners', owner_user_id: users[0].id, status: 'stored',
  });
  const walletId = await insert('credentials', {
    title: 'USDT TRC-20 (виплати)', kind: 'wallet', login: 'TKq...9fH',
    password_enc: encrypt('seed phrase у холодному сховищі'), sensitivity: 'sensitive',
    owner_user_id: users[8].id, status: 'stored',
  });
  await insert('access_requests', {
    credential_id: walletId, user_id: creators[0].id, reason: 'звірити виплату за минулий тиждень',
    expires_at: null,
  });

  await insert('tasks', { title: 'Змонтувати 10 варіантів під Casino X UA', assignee_user_id: users[6].id, creator_user_id: users[1].id, status: 'in_progress', due_date: day(-2) });
  await insert('tasks', { title: 'Перезняти хук «скрін виплати»', assignee_user_id: users[6].id, creator_user_id: users[1].id, status: 'todo', due_date: day(-5) });

  console.log(`Демо-дані: ${accounts.length} акаунтів, ${posts} публікацій, ${(await all('SELECT id FROM conversions')).length} конверсій.`);
  console.log('Демо-логіни: head@gennect.local / lead.a@gennect.local / creator1@gennect.local … пароль demo1234');
}

await initSchema();
await ensureAdmin();
if (!process.argv.includes('--admin')) await seedDemo();
await close();
