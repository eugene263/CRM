// Єдиний опис сутностей: з нього будуються і REST-ендпоїнти, і форми/таблиці
// в інтерфейсі (/api/meta). Додали поле тут — воно зʼявилось скрізь.
const S = (...v) => v.map((x) => (Array.isArray(x) ? { value: x[0], label: x[1] } : { value: x, label: x }));

export const entities = {
  // ── Команда ────────────────────────────────────────────────────────────
  users: {
    label: 'Користувачі', group: 'Команда', icon: '👤', teamField: 'team_id', ownField: 'id',
    title: 'name',
    fields: [
      { name: 'name', label: 'Імʼя', type: 'text', required: true, list: true },
      { name: 'email', label: 'Email', type: 'text', required: true, list: true },
      { name: 'role', label: 'Роль', type: 'select', required: true, list: true, options: S(
        ['owner', 'Власник'], ['head', 'Хед'], ['teamlead', 'Тімлід'], ['creator', 'Крієйтор'],
        ['editor', 'Монтажер'], ['farmer', 'Фармер'], ['finance', 'Фінансист'], ['analyst', 'Аналітик']) },
      { name: 'team_id', label: 'Команда', type: 'ref', ref: 'teams', list: true },
      { name: 'telegram_id', label: 'Telegram ID', type: 'text' },
      { name: 'password', label: 'Пароль', type: 'password', virtual: true, hint: 'Заповніть, щоб задати/змінити' },
      { name: 'status', label: 'Статус', type: 'select', list: true, options: S(['active', 'Активний'], ['disabled', 'Вимкнений']) },
      { name: 'created_at', label: 'Створено', type: 'datetime', readOnly: true },
    ],
  },
  teams: {
    label: 'Команди', group: 'Команда', icon: '👥', title: 'name',
    fields: [
      { name: 'name', label: 'Назва', type: 'text', required: true, list: true },
      { name: 'lead_user_id', label: 'Тімлід', type: 'ref', ref: 'users', list: true },
      { name: 'note', label: 'Нотатка', type: 'textarea' },
    ],
  },

  // ── Ресурси ────────────────────────────────────────────────────────────
  accounts: {
    label: 'Акаунти', group: 'Ресурси', icon: '📱', ownField: 'owner_user_id', teamField: 'team_id',
    title: 'nickname',
    fields: [
      { name: 'platform', label: 'Платформа', type: 'select', required: true, list: true, options: S(
        ['tiktok', 'TikTok'], ['instagram', 'Instagram'], ['youtube', 'YouTube'],
        ['facebook', 'Facebook'], ['threads', 'Threads'], ['x', 'X']) },
      { name: 'nickname', label: 'Нік', type: 'text', required: true, list: true },
      { name: 'url', label: 'URL', type: 'url' },
      { name: 'status', label: 'Статус', type: 'select', list: true, options: S(
        ['farm', 'Фарм'], ['active', 'Актив'], ['shadowban', 'Шедоубан'], ['ban', 'Бан'], ['sold', 'Проданий']) },
      { name: 'geo', label: 'Гео', type: 'text', list: true },
      { name: 'registered_at', label: 'Реєстрація', type: 'date' },
      { name: 'farm_started_at', label: 'Старт фарму', type: 'date' },
      { name: 'live_started_at', label: 'Старт заливу', type: 'date' },
      { name: 'banned_at', label: 'Дата бану', type: 'date', readOnly: true },
      { name: 'owner_user_id', label: 'Відповідальний', type: 'ref', ref: 'users', list: true },
      { name: 'team_id', label: 'Команда', type: 'ref', ref: 'teams' },
      { name: 'device_id', label: 'Девайс', type: 'ref', ref: 'devices' },
      { name: 'proxy_id', label: 'Проксі', type: 'ref', ref: 'proxies' },
      { name: 'sim_id', label: 'SIM', type: 'ref', ref: 'sims' },
      { name: 'mail_id', label: 'Пошта', type: 'ref', ref: 'mail_accounts' },
      { name: 'cost', label: 'Вартість, $', type: 'money', hideFor: ['creator', 'editor'] },
      { name: 'password_enc', label: 'Пароль акаунта', type: 'secret' },
      { name: 'note', label: 'Нотатка', type: 'textarea' },
      { name: 'created_at', label: 'Створено', type: 'datetime', readOnly: true },
    ],
  },
  devices: {
    label: 'Девайси', group: 'Ресурси', icon: '📟', title: 'model',
    fields: [
      { name: 'model', label: 'Модель', type: 'text', required: true, list: true },
      { name: 'imei', label: 'IMEI', type: 'text', list: true },
      { name: 'status', label: 'Статус', type: 'select', list: true, options: S(
        ['free', 'Вільний'], ['in_use', 'У роботі'], ['repair', 'Ремонт'], ['dead', 'Списаний']) },
      { name: 'holder_user_id', label: 'Кому видано', type: 'ref', ref: 'users', list: true },
      { name: 'issued_at', label: 'Дата видачі', type: 'date' },
      { name: 'cost', label: 'Вартість, $', type: 'money', hideFor: ['creator', 'editor'] },
      { name: 'note', label: 'Нотатка', type: 'textarea' },
    ],
  },
  sims: {
    label: 'SIM-карти', group: 'Ресурси', icon: '📶', title: 'number',
    fields: [
      { name: 'number', label: 'Номер', type: 'text', required: true, list: true },
      { name: 'operator', label: 'Оператор', type: 'text', list: true },
      { name: 'geo', label: 'Гео', type: 'text', list: true },
      { name: 'device_id', label: 'У девайсі', type: 'ref', ref: 'devices', list: true },
      { name: 'status', label: 'Статус', type: 'select', list: true, options: S(
        ['free', 'Вільна'], ['in_use', 'У роботі'], ['blocked', 'Заблокована'], ['dead', 'Мертва']) },
      { name: 'cost', label: 'Вартість, $', type: 'money', hideFor: ['creator', 'editor'] },
      { name: 'note', label: 'Нотатка', type: 'textarea' },
    ],
  },
  proxies: {
    label: 'Проксі', group: 'Ресурси', icon: '🌐', title: 'host',
    fields: [
      { name: 'kind', label: 'Тип', type: 'select', list: true, options: S(
        ['mobile', 'Мобільний'], ['residential', 'Резидентський'], ['datacenter', 'Датацентр']) },
      { name: 'geo', label: 'Гео', type: 'text', list: true },
      { name: 'provider', label: 'Провайдер', type: 'text', list: true },
      { name: 'host', label: 'Хост:порт', type: 'text', list: true },
      { name: 'credentials_enc', label: 'Логін:пароль', type: 'secret' },
      { name: 'paid_until', label: 'Оплачено до', type: 'date', list: true },
      { name: 'cost', label: 'Вартість, $', type: 'money', hideFor: ['creator', 'editor'] },
      { name: 'status', label: 'Статус', type: 'select', list: true, options: S(
        ['active', 'Активний'], ['expired', 'Протермінований'], ['dead', 'Мертвий']) },
      { name: 'note', label: 'Нотатка', type: 'textarea' },
    ],
  },
  mail_accounts: {
    label: 'Пошти', group: 'Ресурси', icon: '✉️', title: 'login',
    fields: [
      { name: 'login', label: 'Логін', type: 'text', required: true, list: true },
      { name: 'password_enc', label: 'Пароль', type: 'secret' },
      { name: 'service', label: 'Сервіс', type: 'text', list: true },
      { name: 'status', label: 'Статус', type: 'select', list: true, options: S(
        ['active', 'Активна'], ['free', 'Вільна'], ['banned', 'Забанена']) },
      { name: 'cost', label: 'Вартість, $', type: 'money', hideFor: ['creator', 'editor'] },
      { name: 'note', label: 'Нотатка', type: 'textarea' },
    ],
  },
  resource_assignments: {
    label: 'Видача ресурсів', group: 'Ресурси', icon: '🔁', ownField: 'user_id', defaultSort: 'created_at DESC',
    fields: [
      { name: 'resource_type', label: 'Тип', type: 'select', required: true, list: true, options: S(
        ['account', 'Акаунт'], ['device', 'Девайс'], ['sim', 'SIM'], ['proxy', 'Проксі'], ['mail_account', 'Пошта']) },
      { name: 'resource_id', label: 'ID ресурсу', type: 'number', required: true, list: true },
      { name: 'user_id', label: 'Кому', type: 'ref', ref: 'users', list: true },
      { name: 'action', label: 'Дія', type: 'select', list: true, options: S(['issued', 'Видано'], ['returned', 'Повернено']) },
      { name: 'note', label: 'Нотатка', type: 'textarea' },
      { name: 'created_at', label: 'Коли', type: 'datetime', readOnly: true, list: true },
    ],
  },

  // ── Контент ────────────────────────────────────────────────────────────
  creatives: {
    label: 'Креативи', group: 'Контент', icon: '🎬', ownField: 'author_user_id', teamField: 'team_id', title: 'title',
    fields: [
      { name: 'title', label: 'Назва', type: 'text', required: true, list: true },
      { name: 'vertical', label: 'Вертикаль', type: 'text', list: true },
      { name: 'offer_id', label: 'Офер', type: 'ref', ref: 'offers', list: true },
      { name: 'geo', label: 'Гео', type: 'text', list: true },
      { name: 'hook', label: 'Хук', type: 'text' },
      { name: 'edit_type', label: 'Тип монтажу', type: 'select', options: S(
        ['talking_head', 'Talking head'], ['slideshow', 'Слайдшоу'], ['screencast', 'Скрінкаст'],
        ['ugc', 'UGC'], ['ai', 'AI-генерація']) },
      { name: 'tags', label: 'Теги', type: 'text', hint: 'через кому' },
      { name: 'status', label: 'Статус', type: 'select', list: true, options: S(
        ['draft', 'В роботі'], ['ready', 'Готовий'], ['live', 'У заливі'], ['burned', 'Вигорів'], ['banned', 'Забанений']) },
      { name: 'file_url', label: 'Файл (S3/R2)', type: 'url' },
      { name: 'preview_url', label: 'Превʼю', type: 'url' },
      { name: 'author_user_id', label: 'Автор', type: 'ref', ref: 'users', list: true },
      { name: 'team_id', label: 'Команда', type: 'ref', ref: 'teams' },
      { name: 'note', label: 'Нотатка', type: 'textarea' },
      { name: 'created_at', label: 'Створено', type: 'datetime', readOnly: true },
    ],
  },
  creative_versions: {
    label: 'Версії креативів', group: 'Контент', icon: '🗂', ownField: 'user_id', defaultSort: 'created_at DESC',
    fields: [
      { name: 'creative_id', label: 'Креатив', type: 'ref', ref: 'creatives', required: true, list: true },
      { name: 'version', label: 'Версія', type: 'number', list: true },
      { name: 'file_url', label: 'Файл', type: 'url', list: true },
      { name: 'user_id', label: 'Хто', type: 'ref', ref: 'users' },
      { name: 'note', label: 'Нотатка', type: 'textarea' },
      { name: 'created_at', label: 'Коли', type: 'datetime', readOnly: true, list: true },
    ],
  },
  tasks: {
    label: 'Задачі', group: 'Контент', icon: '✅', ownField: 'assignee_user_id', title: 'title',
    fields: [
      { name: 'title', label: 'Задача', type: 'text', required: true, list: true },
      { name: 'description', label: 'ТЗ', type: 'textarea' },
      { name: 'assignee_user_id', label: 'Виконавець', type: 'ref', ref: 'users', list: true },
      { name: 'creator_user_id', label: 'Постановник', type: 'ref', ref: 'users' },
      { name: 'creative_id', label: 'Креатив', type: 'ref', ref: 'creatives' },
      { name: 'status', label: 'Статус', type: 'select', list: true, options: S(
        ['todo', 'До роботи'], ['in_progress', 'В роботі'], ['review', 'На перевірці'],
        ['done', 'Прийнято'], ['rejected', 'Відхилено']) },
      { name: 'due_date', label: 'Дедлайн', type: 'date', list: true },
    ],
  },

  // ── Заливи ─────────────────────────────────────────────────────────────
  posts: {
    label: 'Публікації', group: 'Заливи', icon: '📤', ownField: 'user_id', teamField: 'team_id', defaultSort: 'posted_at DESC',
    fields: [
      { name: 'posted_at', label: 'Дата', type: 'datetime', list: true, required: true },
      { name: 'account_id', label: 'Акаунт', type: 'ref', ref: 'accounts', required: true, list: true },
      { name: 'creative_id', label: 'Креатив', type: 'ref', ref: 'creatives', list: true },
      { name: 'offer_id', label: 'Офер', type: 'ref', ref: 'offers', list: true },
      { name: 'user_id', label: 'Крієйтор', type: 'ref', ref: 'users', list: true },
      { name: 'team_id', label: 'Команда', type: 'ref', ref: 'teams' },
      { name: 'url', label: 'Лінк', type: 'url' },
      { name: 'views', label: 'Перегляди', type: 'number', list: true },
      { name: 'likes', label: 'Лайки', type: 'number' },
      { name: 'comments', label: 'Коменти', type: 'number' },
      { name: 'clicks', label: 'Переходи', type: 'number', list: true },
      { name: 'status', label: 'Статус', type: 'select', list: true, options: S(
        ['live', 'Живий'], ['deleted', 'Видалений'], ['shadowban', 'Шедоубан']) },
      { name: 'note', label: 'Нотатка', type: 'textarea' },
    ],
  },

  // ── Монетизація ────────────────────────────────────────────────────────
  partners: {
    label: 'Партнерки', group: 'Монетизація', icon: '🤝', title: 'name',
    fields: [
      { name: 'name', label: 'Назва', type: 'text', required: true, list: true },
      { name: 'contact', label: 'Контакт', type: 'text', list: true },
      { name: 'terms', label: 'Умови', type: 'textarea' },
      { name: 'postback_token', label: 'Postback-токен', type: 'text', readOnly: true, list: true },
      { name: 'balance', label: 'Баланс, $', type: 'money', list: true },
      { name: 'status', label: 'Статус', type: 'select', list: true, options: S(['active', 'Активна'], ['paused', 'Пауза']) },
      { name: 'note', label: 'Нотатка', type: 'textarea' },
    ],
  },
  offers: {
    label: 'Офери', group: 'Монетизація', icon: '🎯', title: 'name',
    fields: [
      { name: 'name', label: 'Назва', type: 'text', required: true, list: true },
      { name: 'partner_id', label: 'Партнерка', type: 'ref', ref: 'partners', list: true, hideFor: ['creator', 'editor'] },
      { name: 'vertical', label: 'Вертикаль', type: 'text', list: true },
      { name: 'geo', label: 'Гео', type: 'text', list: true },
      { name: 'payout', label: 'Ставка, $', type: 'money', list: true, hideFor: ['creator', 'editor', 'farmer'] },
      { name: 'currency', label: 'Валюта', type: 'text', hideFor: ['creator', 'editor', 'farmer'] },
      { name: 'model', label: 'Модель', type: 'select', list: true, options: S('CPA', 'RevShare', 'CPL') },
      { name: 'hold_days', label: 'Холд, днів', type: 'number' },
      { name: 'cap_daily', label: 'Кап/добу', type: 'number' },
      { name: 'landing_url', label: 'Лендінг', type: 'url' },
      { name: 'status', label: 'Статус', type: 'select', list: true, options: S(['active', 'Активний'], ['paused', 'Пауза'], ['stopped', 'Стоп']) },
      { name: 'note', label: 'Нотатка', type: 'textarea' },
    ],
  },
  offer_rates_history: {
    label: 'Історія ставок', group: 'Монетизація', icon: '📈', defaultSort: 'created_at DESC',
    fields: [
      { name: 'offer_id', label: 'Офер', type: 'ref', ref: 'offers', list: true },
      { name: 'payout', label: 'Ставка, $', type: 'money', list: true, hideFor: ['creator', 'editor', 'farmer'] },
      { name: 'user_id', label: 'Хто змінив', type: 'ref', ref: 'users', list: true },
      { name: 'created_at', label: 'Коли', type: 'datetime', readOnly: true, list: true },
    ],
  },
  tracking_links: {
    label: 'Трекінг-лінки', group: 'Монетизація', icon: '🔗', ownField: 'user_id', defaultSort: 'created_at DESC',
    fields: [
      { name: 'slug', label: 'Slug', type: 'text', readOnly: true, list: true },
      { name: 'offer_id', label: 'Офер', type: 'ref', ref: 'offers', required: true, list: true },
      { name: 'account_id', label: 'Акаунт', type: 'ref', ref: 'accounts', list: true },
      { name: 'creative_id', label: 'Креатив', type: 'ref', ref: 'creatives', list: true },
      { name: 'post_id', label: 'Публікація', type: 'ref', ref: 'posts' },
      { name: 'user_id', label: 'Крієйтор', type: 'ref', ref: 'users', list: true },
      { name: 'target_url', label: 'Куди веде', type: 'url', required: true },
      { name: 'clicks', label: 'Кліки', type: 'number', readOnly: true, list: true },
      { name: 'created_at', label: 'Створено', type: 'datetime', readOnly: true },
    ],
  },
  conversions: {
    label: 'Конверсії', group: 'Монетизація', icon: '💸', ownField: 'user_id', defaultSort: 'converted_at DESC',
    fields: [
      { name: 'converted_at', label: 'Дата', type: 'datetime', list: true },
      { name: 'event', label: 'Подія', type: 'select', list: true, options: S(
        ['click', 'Клік'], ['reg', 'Рега'], ['dep', 'Деп'], ['sale', 'Продаж']) },
      { name: 'status', label: 'Статус', type: 'select', list: true, options: S(
        ['hold', 'Холд'], ['approved', 'Апрув'], ['rejected', 'Відхилено'], ['paid', 'Виплачено']) },
      { name: 'payout', label: 'Виплата, $', type: 'money', list: true, hideFor: ['creator', 'editor', 'farmer'] },
      { name: 'offer_id', label: 'Офер', type: 'ref', ref: 'offers', list: true },
      { name: 'account_id', label: 'Акаунт', type: 'ref', ref: 'accounts', list: true },
      { name: 'creative_id', label: 'Креатив', type: 'ref', ref: 'creatives', list: true },
      { name: 'user_id', label: 'Крієйтор', type: 'ref', ref: 'users', list: true },
      { name: 'post_id', label: 'Публікація', type: 'ref', ref: 'posts' },
      { name: 'partner_id', label: 'Партнерка', type: 'ref', ref: 'partners', hideFor: ['creator', 'editor'] },
      { name: 'click_id', label: 'Click ID', type: 'text' },
      { name: 'external_id', label: 'ID у партнерці', type: 'text' },
      { name: 'source', label: 'Джерело', type: 'select', list: true, options: S(
        ['manual', 'Вручну'], ['postback', 'Postback'], ['keitaro', 'Keitaro'], ['import', 'Імпорт CSV']) },
    ],
  },

  // ── Фінанси ────────────────────────────────────────────────────────────
  expenses: {
    label: 'Витрати', group: 'Фінанси', icon: '🧾', teamField: 'team_id', defaultSort: 'spent_at DESC',
    fields: [
      { name: 'spent_at', label: 'Дата', type: 'date', required: true, list: true },
      { name: 'category', label: 'Категорія', type: 'select', required: true, list: true, options: S(
        ['accounts', 'Акаунти'], ['proxy', 'Проксі'], ['sim', 'SIM'], ['device', 'Девайси'],
        ['service', 'Сервіси'], ['salary', 'ЗП'], ['other', 'Інше']) },
      { name: 'amount', label: 'Сума, $', type: 'money', required: true, list: true },
      { name: 'currency', label: 'Валюта', type: 'text' },
      { name: 'user_id', label: 'Хто', type: 'ref', ref: 'users', list: true },
      { name: 'team_id', label: 'Команда', type: 'ref', ref: 'teams', list: true },
      { name: 'resource_type', label: 'Тип ресурсу', type: 'text' },
      { name: 'resource_id', label: 'ID ресурсу', type: 'number' },
      { name: 'note', label: 'Нотатка', type: 'textarea' },
    ],
  },
  salary_rules: {
    label: 'Правила ЗП', group: 'Фінанси', icon: '📐',
    fields: [
      { name: 'user_id', label: 'Співробітник', type: 'ref', ref: 'users', list: true },
      { name: 'role', label: 'Або роль', type: 'text', list: true, hint: 'якщо правило для всієї ролі' },
      { name: 'fix_amount', label: 'Фікс, $', type: 'money', list: true },
      { name: 'percent_of_profit', label: '% від профіту', type: 'number', list: true },
      { name: 'bonus_metric', label: 'Бонус за метрику', type: 'select', options: S(
        ['posts', 'Публікації'], ['deps', 'Депи'], ['profit', 'Профіт']) },
      { name: 'bonus_target', label: 'Ціль бонуса', type: 'number' },
      { name: 'bonus_amount', label: 'Сума бонуса, $', type: 'money' },
      { name: 'active_from', label: 'Діє з', type: 'date' },
      { name: 'note', label: 'Нотатка', type: 'textarea' },
    ],
  },
  payouts: {
    label: 'Виплати команді', group: 'Фінанси', icon: '💰', ownField: 'user_id', defaultSort: 'period DESC',
    fields: [
      { name: 'period', label: 'Період', type: 'text', required: true, list: true, hint: 'YYYY-MM' },
      { name: 'user_id', label: 'Співробітник', type: 'ref', ref: 'users', required: true, list: true },
      { name: 'fix_amount', label: 'Фікс, $', type: 'money', list: true },
      { name: 'percent_amount', label: '% від профіту, $', type: 'money', list: true },
      { name: 'bonus_amount', label: 'Бонус, $', type: 'money', list: true },
      { name: 'total', label: 'Разом, $', type: 'money', list: true },
      { name: 'status', label: 'Статус', type: 'select', list: true, options: S(
        ['accrued', 'Нараховано'], ['paid', 'Виплачено'], ['canceled', 'Скасовано']) },
      { name: 'paid_at', label: 'Дата виплати', type: 'date' },
      { name: 'note', label: 'Нотатка', type: 'textarea' },
    ],
  },
  kpi_targets: {
    label: 'KPI-плани', group: 'Фінанси', icon: '🎚', ownField: 'user_id',
    fields: [
      { name: 'user_id', label: 'Співробітник', type: 'ref', ref: 'users', required: true, list: true },
      { name: 'period', label: 'Період', type: 'text', required: true, list: true, hint: 'YYYY-MM або YYYY-MM-DD' },
      { name: 'metric', label: 'Метрика', type: 'select', required: true, list: true, options: S(
        ['posts', 'Публікації'], ['deps', 'Депи'], ['profit', 'Профіт']) },
      { name: 'target', label: 'План', type: 'number', required: true, list: true },
      { name: 'note', label: 'Нотатка', type: 'textarea' },
    ],
  },

  // ── Сейф доступів ──────────────────────────────────────────────────────
  credentials: {
    // «Свої» для сейфа — це видані на руки, а не створені: крієйтор має
    // бачити рівно те, що йому виписали.
    label: 'Сейф доступів', group: 'Доступи', icon: '🔐', ownField: 'holder_user_id', teamField: 'team_id', title: 'title',
    fields: [
      { name: 'title', label: 'Назва', type: 'text', required: true, list: true },
      { name: 'kind', label: 'Тип', type: 'select', required: true, list: true, options: S(
        ['mail', 'Пошта'], ['account', 'Акаунт'], ['card', 'Картка'], ['service', 'Сервіс'],
        ['wallet', 'Гаманець'], ['totp', '2FA-сід']) },
      { name: 'login', label: 'Логін', type: 'text', list: true, mask: 'partial' },
      { name: 'password_enc', label: 'Пароль', type: 'secret' },
      { name: 'recovery_enc', label: 'Recovery-дані', type: 'secret' },
      { name: 'totp_seed_enc', label: '2FA seed', type: 'secret', hint: 'CRM сама видасть код — не треба гнати 2FA в Telegram' },
      { name: 'notes_enc', label: 'Закриті нотатки', type: 'secret' },
      { name: 'sensitivity', label: 'Чутливість', type: 'select', list: true, options: S(
        ['normal', 'Звичайна'], ['sensitive', 'Чутлива (потрібен апрув)']) },
      { name: 'service', label: 'Сервіс', type: 'text', list: true },
      { name: 'geo', label: 'Гео', type: 'text' },
      { name: 'owner_user_id', label: 'Власник ресурсу', type: 'ref', ref: 'users', list: true },
      { name: 'team_id', label: 'Команда', type: 'ref', ref: 'teams' },
      { name: 'holder_user_id', label: 'На руках у', type: 'ref', ref: 'users', list: true, readOnly: true },
      { name: 'resource_type', label: 'Тип ресурсу', type: 'text' },
      { name: 'resource_id', label: 'ID ресурсу', type: 'number' },
      { name: 'status', label: 'Статус', type: 'select', list: true, options: S(
        ['stored', 'На складі'], ['issued', 'Видано'], ['returned', 'Повернено'],
        ['retired', 'Списано'], ['compromised', 'Скомпрометовано']) },
      { name: 'rotate_required', label: 'Потребує ротації', type: 'number', list: true, readOnly: true },
      { name: 'last_rotated_at', label: 'Остання ротація', type: 'date' },
      { name: 'note', label: 'Нотатка', type: 'textarea' },
    ],
  },
  credential_grants: {
    label: 'Видача доступів', group: 'Доступи', icon: '🪪', ownField: 'user_id', defaultSort: 'granted_at DESC',
    readOnlyEntity: true,
    fields: [
      { name: 'credential_id', label: 'Доступ', type: 'ref', ref: 'credentials', list: true },
      { name: 'user_id', label: 'Кому', type: 'ref', ref: 'users', list: true },
      { name: 'granted_by', label: 'Хто видав', type: 'ref', ref: 'users', list: true },
      { name: 'granted_at', label: 'Видано', type: 'datetime', list: true },
      { name: 'due_at', label: 'Повернути до', type: 'datetime', list: true },
      { name: 'returned_at', label: 'Повернено', type: 'datetime', list: true },
      { name: 'state_out', label: 'Стан при видачі', type: 'text' },
      { name: 'state_in', label: 'Стан при поверненні', type: 'text' },
      { name: 'status', label: 'Статус', type: 'select', list: true, options: S(
        ['active', 'На руках'], ['returned', 'Повернено'], ['revoked', 'Відкликано'], ['expired', 'Протерміновано']) },
      { name: 'note', label: 'Нотатка', type: 'text' },
    ],
  },
  access_requests: {
    label: 'Запити на доступ', group: 'Доступи', icon: '🙋', ownField: 'user_id', defaultSort: 'created_at DESC',
    fields: [
      { name: 'credential_id', label: 'Доступ', type: 'ref', ref: 'credentials', required: true, list: true },
      { name: 'user_id', label: 'Хто просить', type: 'ref', ref: 'users', list: true, readOnly: true },
      { name: 'reason', label: 'Навіщо', type: 'textarea', required: true },
      { name: 'status', label: 'Статус', type: 'select', list: true, readOnly: true, options: S(
        ['pending', 'Очікує'], ['approved', 'Схвалено'], ['rejected', 'Відхилено'], ['expired', 'Протерміновано']) },
      { name: 'decided_by', label: 'Рішення від', type: 'ref', ref: 'users', list: true, readOnly: true },
      { name: 'expires_at', label: 'Діє до', type: 'datetime', list: true, readOnly: true },
      { name: 'created_at', label: 'Створено', type: 'datetime', list: true, readOnly: true },
    ],
  },

  // ── Службові ───────────────────────────────────────────────────────────
  clicks: {
    label: 'Кліки', group: 'Службові', icon: '🖱', readOnlyEntity: true, defaultSort: 'created_at DESC',
    fields: [
      { name: 'created_at', label: 'Коли', type: 'datetime', list: true },
      { name: 'tracking_link_id', label: 'Лінк', type: 'ref', ref: 'tracking_links', list: true },
      { name: 'click_id', label: 'Click ID', type: 'text', list: true },
      { name: 'geo', label: 'Гео', type: 'text', list: true },
      { name: 'device', label: 'Девайс', type: 'text', list: true },
      { name: 'referer', label: 'Реферер', type: 'text', list: true },
      { name: 'ip_hash', label: 'IP (хеш)', type: 'text' },
      { name: 'user_agent', label: 'User-Agent', type: 'text' },
    ],
  },
  account_events: {
    label: 'Історія акаунтів', group: 'Службові', icon: '🕓', defaultSort: 'created_at DESC',
    fields: [
      { name: 'account_id', label: 'Акаунт', type: 'ref', ref: 'accounts', list: true },
      { name: 'from_status', label: 'Було', type: 'text', list: true },
      { name: 'to_status', label: 'Стало', type: 'text', list: true },
      { name: 'user_id', label: 'Хто', type: 'ref', ref: 'users', list: true },
      { name: 'note', label: 'Нотатка', type: 'text' },
      { name: 'created_at', label: 'Коли', type: 'datetime', readOnly: true, list: true },
    ],
  },
  notifications: {
    label: 'Сповіщення', group: 'Службові', icon: '🔔', defaultSort: 'created_at DESC',
    fields: [
      { name: 'kind', label: 'Тип', type: 'text', list: true },
      { name: 'text', label: 'Текст', type: 'textarea', list: true },
      { name: 'user_id', label: 'Кому', type: 'ref', ref: 'users', list: true },
      { name: 'status', label: 'Статус', type: 'select', list: true, options: S(
        ['pending', 'В черзі'], ['sent', 'Надіслано'], ['failed', 'Помилка']) },
      { name: 'error', label: 'Помилка', type: 'text' },
      { name: 'created_at', label: 'Коли', type: 'datetime', readOnly: true, list: true },
    ],
  },
  audit_log: {
    label: 'Аудит-лог', group: 'Службові', icon: '🛡', readOnlyEntity: true, defaultSort: 'created_at DESC',
    fields: [
      { name: 'created_at', label: 'Коли', type: 'datetime', list: true },
      { name: 'user_id', label: 'Хто', type: 'ref', ref: 'users', list: true },
      { name: 'action', label: 'Дія', type: 'text', list: true },
      { name: 'entity', label: 'Сутність', type: 'text', list: true },
      { name: 'entity_id', label: 'ID', type: 'number', list: true },
      { name: 'payload', label: 'Деталі', type: 'textarea', list: true },
      { name: 'ip', label: 'IP', type: 'text' },
    ],
  },
};

for (const [key, ent] of Object.entries(entities)) {
  ent.key = key;
  ent.table = key;
  ent.defaultSort ||= 'id DESC';
  ent.title ||= 'id';
}

export const fieldOf = (entKey, name) => entities[entKey]?.fields.find((f) => f.name === name);
