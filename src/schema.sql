-- Gennect CRM :: схема БД (SQLite; сумісна за структурою з PostgreSQL-міграцією)
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  lead_user_id INTEGER,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,                  -- owner|head|teamlead|creator|editor|farmer|finance|analyst
  team_id INTEGER REFERENCES teams(id),
  telegram_id TEXT,
  password_hash TEXT NOT NULL,
  totp_secret TEXT,
  status TEXT NOT NULL DEFAULT 'active',  -- active|disabled
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_team ON users(team_id);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- ── Ресурси ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY,
  model TEXT NOT NULL,
  imei TEXT,
  status TEXT NOT NULL DEFAULT 'free',     -- free|in_use|repair|dead
  holder_user_id INTEGER REFERENCES users(id),
  issued_at TEXT,
  cost REAL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sims (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL,
  operator TEXT,
  geo TEXT,
  device_id INTEGER REFERENCES devices(id),
  status TEXT NOT NULL DEFAULT 'free',     -- free|in_use|blocked|dead
  cost REAL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS proxies (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'mobile',     -- mobile|residential|datacenter
  geo TEXT,
  provider TEXT,
  host TEXT,
  credentials_enc TEXT,
  paid_until TEXT,
  cost REAL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',   -- active|expired|dead
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mail_accounts (
  id INTEGER PRIMARY KEY,
  login TEXT NOT NULL,
  password_enc TEXT,
  service TEXT,                            -- gmail|outlook|firstmail|...
  status TEXT NOT NULL DEFAULT 'active',   -- active|banned|free
  cost REAL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL,                  -- tiktok|instagram|youtube|facebook|threads|x
  nickname TEXT NOT NULL,
  url TEXT,
  status TEXT NOT NULL DEFAULT 'farm',     -- farm|active|shadowban|ban|sold
  geo TEXT,
  registered_at TEXT,
  farm_started_at TEXT,
  live_started_at TEXT,
  banned_at TEXT,
  mail_id INTEGER REFERENCES mail_accounts(id),
  device_id INTEGER REFERENCES devices(id),
  proxy_id INTEGER REFERENCES proxies(id),
  sim_id INTEGER REFERENCES sims(id),
  owner_user_id INTEGER REFERENCES users(id),
  team_id INTEGER REFERENCES teams(id),
  cost REAL DEFAULT 0,
  password_enc TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_accounts_owner ON accounts(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);

CREATE TABLE IF NOT EXISTS account_events (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_account_events_acc ON account_events(account_id);

CREATE TABLE IF NOT EXISTS resource_assignments (
  id INTEGER PRIMARY KEY,
  resource_type TEXT NOT NULL,             -- account|device|sim|proxy|mail_account
  resource_id INTEGER NOT NULL,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL DEFAULT 'issued',   -- issued|returned
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assign_res ON resource_assignments(resource_type, resource_id);

-- ── Партнерки та офери ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS partners (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  contact TEXT,
  terms TEXT,
  postback_token TEXT,
  balance REAL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY,
  partner_id INTEGER REFERENCES partners(id),
  name TEXT NOT NULL,
  vertical TEXT,                           -- gambling|betting|nutra|dating|crypto|finance
  geo TEXT,
  payout REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  model TEXT NOT NULL DEFAULT 'CPA',       -- CPA|RevShare|CPL
  hold_days INTEGER DEFAULT 0,
  cap_daily INTEGER,
  landing_url TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS offer_rates_history (
  id INTEGER PRIMARY KEY,
  offer_id INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  payout REAL NOT NULL,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Контент ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS creatives (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  vertical TEXT,
  offer_id INTEGER REFERENCES offers(id),
  geo TEXT,
  hook TEXT,
  edit_type TEXT,                          -- talking_head|slideshow|screencast|ugc|ai
  tags TEXT,
  status TEXT NOT NULL DEFAULT 'draft',    -- draft|ready|live|burned|banned
  file_url TEXT,
  preview_url TEXT,
  author_user_id INTEGER REFERENCES users(id),
  team_id INTEGER REFERENCES teams(id),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS creative_versions (
  id INTEGER PRIMARY KEY,
  creative_id INTEGER NOT NULL REFERENCES creatives(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  file_url TEXT,
  user_id INTEGER REFERENCES users(id),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  assignee_user_id INTEGER REFERENCES users(id),
  creator_user_id INTEGER REFERENCES users(id),
  creative_id INTEGER REFERENCES creatives(id),
  status TEXT NOT NULL DEFAULT 'todo',     -- todo|in_progress|review|done|rejected
  due_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Заливи ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  creative_id INTEGER REFERENCES creatives(id),
  offer_id INTEGER REFERENCES offers(id),
  user_id INTEGER REFERENCES users(id),
  team_id INTEGER REFERENCES teams(id),
  posted_at TEXT NOT NULL DEFAULT (datetime('now')),
  url TEXT,
  views INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'live',     -- live|deleted|shadowban
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_posts_user_date ON posts(user_id, posted_at);
CREATE INDEX IF NOT EXISTS idx_posts_account ON posts(account_id);

-- ── Трекінг ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tracking_links (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  offer_id INTEGER REFERENCES offers(id),
  account_id INTEGER REFERENCES accounts(id),
  creative_id INTEGER REFERENCES creatives(id),
  user_id INTEGER REFERENCES users(id),
  post_id INTEGER REFERENCES posts(id),
  target_url TEXT NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clicks (
  id INTEGER PRIMARY KEY,
  tracking_link_id INTEGER REFERENCES tracking_links(id),
  click_id TEXT,
  ip_hash TEXT,
  user_agent TEXT,
  geo TEXT,
  device TEXT,
  referer TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_clicks_link ON clicks(tracking_link_id, created_at);

CREATE TABLE IF NOT EXISTS conversions (
  id INTEGER PRIMARY KEY,
  external_id TEXT,
  partner_id INTEGER REFERENCES partners(id),
  offer_id INTEGER REFERENCES offers(id),
  account_id INTEGER REFERENCES accounts(id),
  creative_id INTEGER REFERENCES creatives(id),
  user_id INTEGER REFERENCES users(id),
  post_id INTEGER REFERENCES posts(id),
  click_id TEXT,
  event TEXT NOT NULL DEFAULT 'dep',       -- click|reg|dep|sale
  status TEXT NOT NULL DEFAULT 'hold',     -- hold|approved|rejected|paid
  payout REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  source TEXT NOT NULL DEFAULT 'manual',   -- manual|postback|keitaro|import
  converted_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_conv_external ON conversions(partner_id, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conv_date ON conversions(converted_at);
CREATE INDEX IF NOT EXISTS idx_conv_user ON conversions(user_id);

-- ── Фінанси ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY,
  category TEXT NOT NULL,                  -- accounts|proxy|sim|device|service|ads|other
  amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  spent_at TEXT NOT NULL DEFAULT (date('now')),
  resource_type TEXT,
  resource_id INTEGER,
  user_id INTEGER REFERENCES users(id),
  team_id INTEGER REFERENCES teams(id),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(spent_at);

CREATE TABLE IF NOT EXISTS salary_rules (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  role TEXT,
  fix_amount REAL NOT NULL DEFAULT 0,
  percent_of_profit REAL NOT NULL DEFAULT 0,
  bonus_metric TEXT,                       -- posts|deps|profit
  bonus_target REAL DEFAULT 0,
  bonus_amount REAL DEFAULT 0,
  active_from TEXT NOT NULL DEFAULT (date('now')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payouts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  period TEXT NOT NULL,                    -- YYYY-MM
  fix_amount REAL NOT NULL DEFAULT 0,
  percent_amount REAL NOT NULL DEFAULT 0,
  bonus_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'accrued',  -- accrued|paid|canceled
  paid_at TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payout_period ON payouts(user_id, period);

CREATE TABLE IF NOT EXISTS kpi_targets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  period TEXT NOT NULL,                    -- YYYY-MM або YYYY-MM-DD
  metric TEXT NOT NULL,                    -- posts|deps|profit
  target REAL NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Службові ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,                    -- login|create|update|delete|export|reveal|denied
  entity TEXT,
  entity_id INTEGER,
  payload TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_date ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                      -- ban|plan|conversion|proxy_expiry|salary
  text TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|sent|failed
  sent_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- ── Сейф доступів (vault) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credentials (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'service',   -- mail|account|card|service|wallet|totp
  title TEXT NOT NULL,
  login TEXT,
  password_enc TEXT,
  recovery_enc TEXT,
  totp_seed_enc TEXT,
  notes_enc TEXT,
  sensitivity TEXT NOT NULL DEFAULT 'normal',  -- normal|sensitive (картки, гаманці, кабінети)
  service TEXT,
  geo TEXT,
  owner_user_id INTEGER REFERENCES users(id),
  team_id INTEGER REFERENCES teams(id),
  holder_user_id INTEGER REFERENCES users(id),
  resource_type TEXT,
  resource_id INTEGER,
  status TEXT NOT NULL DEFAULT 'stored',  -- stored|issued|returned|retired|compromised
  rotate_required INTEGER NOT NULL DEFAULT 0,
  last_rotated_at TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cred_holder ON credentials(holder_user_id);
CREATE INDEX IF NOT EXISTS idx_cred_status ON credentials(status);

CREATE TABLE IF NOT EXISTS credential_grants (
  id INTEGER PRIMARY KEY,
  credential_id INTEGER NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  granted_by INTEGER REFERENCES users(id),
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  due_at TEXT,
  returned_at TEXT,
  state_out TEXT,
  state_in TEXT,
  status TEXT NOT NULL DEFAULT 'active',  -- active|returned|revoked|expired
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_grant_cred ON credential_grants(credential_id, status);

CREATE TABLE IF NOT EXISTS access_requests (
  id INTEGER PRIMARY KEY,
  credential_id INTEGER NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|rejected|expired
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_access_req ON access_requests(credential_id, user_id, status);

-- ── Ролі та права у БД (замість захардкоженої матриці) ────────────────────
CREATE TABLE IF NOT EXISTS roles (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  is_system INTEGER NOT NULL DEFAULT 0,
  can_export INTEGER NOT NULL DEFAULT 0,
  can_reveal INTEGER NOT NULL DEFAULT 0,
  can_salary_calc INTEGER NOT NULL DEFAULT 0,
  can_settings INTEGER NOT NULL DEFAULT 0,
  reveal_daily_limit INTEGER NOT NULL DEFAULT 20,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS role_permissions (
  id INTEGER PRIMARY KEY,
  role_key TEXT NOT NULL REFERENCES roles(key) ON DELETE CASCADE,
  entity TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'none',     -- none|read|write|full
  scope TEXT NOT NULL DEFAULT 'all',      -- all|team|own
  hidden_fields TEXT                      -- через кому
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_role_entity ON role_permissions(role_key, entity);

-- ── Списки пошуку (prospecting) ───────────────────────────────────────────
-- Три рівні: список → лід → контакт → тач. Статус живе і на ліді (де він у
-- воронці), і на кожному тачі (доставлено/прочитано/відповіли).
CREATE TABLE IF NOT EXISTS prospect_lists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL DEFAULT 'manual',     -- manual|import|auto|mixed|smart
  smart_filter TEXT,                       -- JSON-фільтр для смарт-списку
  geo TEXT,
  vertical TEXT,
  language TEXT,
  owner_user_id INTEGER REFERENCES users(id),
  team_id INTEGER REFERENCES teams(id),
  status TEXT NOT NULL DEFAULT 'active',   -- draft|active|paused|closed|archived
  goal_leads INTEGER DEFAULT 0,
  goal_touches INTEGER DEFAULT 0,
  deadline TEXT,
  tags TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS list_members (
  id INTEGER PRIMARY KEY,
  list_id INTEGER NOT NULL REFERENCES prospect_lists(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member'      -- owner|member|viewer
);

-- Статуси лідів редагуються в інтерфейсі, а не в коді.
CREATE TABLE IF NOT EXISTS lead_statuses (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_terminal INTEGER NOT NULL DEFAULT 0,
  is_won INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1
);

-- Спільний довідник: канали джерел, причини дискваліфікації/відмови тощо.
CREATE TABLE IF NOT EXISTS dictionaries (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                      -- source_channel|disqualify_reason|lost_reason|vertical|touch_channel
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dict ON dictionaries(kind, code);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,
  list_id INTEGER REFERENCES prospect_lists(id),
  company_name TEXT NOT NULL,
  website TEXT,
  geo_country TEXT,
  geo_city TEXT,
  address TEXT,
  vertical TEXT,
  size_metric TEXT,
  language TEXT,
  status_code TEXT NOT NULL DEFAULT 'new',
  priority TEXT NOT NULL DEFAULT 'warm',   -- hot|warm|cold
  score INTEGER NOT NULL DEFAULT 0,
  owner_user_id INTEGER REFERENCES users(id),
  team_id INTEGER REFERENCES teams(id),
  disqualify_reason TEXT,
  lost_reason TEXT,
  next_contact_at TEXT,
  snooze_until TEXT,
  google_place_id TEXT,
  phone TEXT,
  email TEXT,
  touches_count INTEGER NOT NULL DEFAULT 0,
  last_touch_at TEXT,
  first_touch_at TEXT,
  replied_at TEXT,
  qualified_at TEXT,
  tags TEXT,
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_leads_list ON leads(list_id, status_code);
CREATE INDEX IF NOT EXISTS idx_leads_queue ON leads(owner_user_id, next_contact_at);
CREATE INDEX IF NOT EXISTS idx_leads_place ON leads(google_place_id);

CREATE TABLE IF NOT EXISTS lead_socials (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,                  -- instagram|tiktok|youtube|facebook
  handle TEXT,
  url TEXT,
  followers INTEGER,
  last_post_at TEXT,
  avg_views INTEGER,
  checked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_socials_lead ON lead_socials(lead_id);
CREATE INDEX IF NOT EXISTS idx_socials_handle ON lead_socials(platform, handle);

-- «Де знайшли» — окрема сутність, бо без неї не порахувати конверсію джерел.
CREATE TABLE IF NOT EXISTS lead_sources (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,                   -- код із dictionaries(source_channel)
  query TEXT,                              -- пошуковий запит або хештег
  url TEXT,
  method TEXT NOT NULL DEFAULT 'manual',   -- manual|import|auto
  signals TEXT,                            -- JSON: ллє рекламу, наймає SMM, мертвий акаунт
  found_by INTEGER REFERENCES users(id),
  found_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lead_sources ON lead_sources(lead_id);

CREATE TABLE IF NOT EXISTS lead_contacts (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                      -- email|phone|instagram|telegram|whatsapp|linkedin|facebook
  value TEXT NOT NULL,
  person_name TEXT,
  position TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_contacts_lead ON lead_contacts(lead_id);
CREATE INDEX IF NOT EXISTS idx_contacts_value ON lead_contacts(kind, value);

CREATE TABLE IF NOT EXISTS message_templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  channel TEXT,
  subject TEXT,
  body TEXT NOT NULL,
  variables TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS touches (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES lead_contacts(id),
  channel TEXT NOT NULL,                   -- instagram_dm|telegram|email|whatsapp|call|...
  direction TEXT NOT NULL DEFAULT 'out',   -- out|in
  from_account TEXT,                       -- з якого нашого акаунта/скриньки
  template_id INTEGER REFERENCES message_templates(id),
  message_text TEXT,
  attachments TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'sent',  -- sent|delivered|read|failed|blocked
  outcome TEXT,                            -- none|positive|negative|later
  touch_number INTEGER NOT NULL DEFAULT 1,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_touches_lead ON touches(lead_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_touches_user ON touches(user_id, sent_at);

CREATE TABLE IF NOT EXISTS lead_status_history (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lead_notes (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lead_tasks (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  due_at TEXT,
  assignee_user_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open',     -- open|done|canceled
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lead_tasks ON lead_tasks(assignee_user_id, status, due_at);

CREATE TABLE IF NOT EXISTS duplicates_queue (
  id INTEGER PRIMARY KEY,
  lead_a_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  lead_b_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  match_score INTEGER NOT NULL DEFAULT 0,
  match_reason TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS suppression_list (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                      -- domain|email|phone|instagram|company
  value TEXT NOT NULL,
  reason TEXT,
  added_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_suppression ON suppression_list(kind, value);

-- ── Плани та норми ────────────────────────────────────────────────────────
-- Норма не вписується зі стелі: вона рахується зворотно від цілі по клієнтах
-- і множиться на рампап новачка та завантаженість дня з календаря.
CREATE TABLE IF NOT EXISTS kpi_metrics (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,               -- leads_found|leads_qualified|touches|...
  name TEXT NOT NULL,
  unit TEXT,
  kind TEXT NOT NULL DEFAULT 'leading',    -- leading|lagging|quality
  direction TEXT NOT NULL DEFAULT 'more',  -- more|less
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS kpi_plans (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  team_id INTEGER REFERENCES teams(id),
  role TEXT,
  metric_code TEXT NOT NULL,
  period_type TEXT NOT NULL DEFAULT 'day', -- day|week|month|quarter
  period_start TEXT NOT NULL,
  period_end TEXT,
  target_value REAL NOT NULL DEFAULT 0,
  min_threshold REAL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_kpi_plans ON kpi_plans(user_id, metric_code, period_type);

CREATE TABLE IF NOT EXISTS kpi_facts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  metric_code TEXT NOT NULL,
  date TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 0,
  valid_value REAL NOT NULL DEFAULT 0,
  rejected_value REAL NOT NULL DEFAULT 0,
  calculated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_kpi_fact ON kpi_facts(user_id, metric_code, date);

CREATE TABLE IF NOT EXISTS plan_calculator (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  goal_deals REAL NOT NULL DEFAULT 4,
  conv_meeting_to_deal REAL NOT NULL DEFAULT 20,
  conv_reply_to_meeting REAL NOT NULL DEFAULT 30,
  reply_rate REAL NOT NULL DEFAULT 8,
  touches_per_lead REAL NOT NULL DEFAULT 2.5,
  qualification_rate REAL NOT NULL DEFAULT 70,
  working_days INTEGER NOT NULL DEFAULT 21,
  headcount REAL NOT NULL DEFAULT 1,
  team_id INTEGER REFERENCES teams(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS work_calendar (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  date TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'work',       -- work|weekend|holiday|vacation|sick
  capacity_percent INTEGER NOT NULL DEFAULT 100,
  note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_calendar ON work_calendar(user_id, date);

CREATE TABLE IF NOT EXISTS ramp_up_plans (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  role TEXT,
  week_number INTEGER NOT NULL,
  metric_code TEXT,
  target_percent INTEGER NOT NULL DEFAULT 100,
  started_at TEXT
);

CREATE TABLE IF NOT EXISTS quality_flags (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  flag_type TEXT NOT NULL,                 -- duplicate|incomplete|bad_qualification|blocked|bounce
  date TEXT NOT NULL DEFAULT (date('now')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_quality_flags ON quality_flags(user_id, date);

CREATE TABLE IF NOT EXISTS bonus_rules (
  id INTEGER PRIMARY KEY,
  role TEXT,
  user_id INTEGER REFERENCES users(id),
  metric_code TEXT NOT NULL,
  threshold_percent REAL NOT NULL DEFAULT 100,
  bonus_coefficient REAL NOT NULL DEFAULT 1,
  quality_gate_percent REAL NOT NULL DEFAULT 15,
  base_amount REAL NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS channel_limits (
  id INTEGER PRIMARY KEY,
  account_name TEXT NOT NULL,              -- скринька або нік, з якого пишемо
  channel TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  daily_limit INTEGER NOT NULL DEFAULT 30,
  warmup_stage TEXT,                       -- new|warming|ready
  is_active INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_account ON channel_limits(account_name, channel);
