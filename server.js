// server.js
// npm i express better-sqlite3 basic-auth cors
const express = require('express');
const basicAuth = require('basic-auth');
const Database = require('better-sqlite3');
const path = require('path');
const cors = require('cors');

const app = express();
app.set('trust proxy', true);            // если за прокси/Cloudflare
app.use(express.json());
app.use(cors({ origin: false }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));

// ====== НАСТРОЙКИ АДМИНКИ ======
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'change_me_strong_pass';

// Базовая защита: HTTP Basic Auth
function auth(req, res, next) {
  const user = basicAuth(req);
  if (!user || user.name !== ADMIN_USER || user.pass !== ADMIN_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Auth required');
  }
  next();
}

// ====== БАЗА ДАННЫХ ======
const db = new Database(path.join(__dirname, 'data.sqlite'));
db.pragma('journal_mode = WAL');

// Таблицы
db.exec(`
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  ip TEXT,
  ua TEXT,
  country TEXT,
  path TEXT,
  ref TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

// Инициализация ссылок по умолчанию
const defaultLinks = {
  fortune: "fortune.html",
  job: "#",
  buttons: {
    operator:"https://t.me/",
    chats:"https://t.me/",
    reviews:"https://t.me/",
    bot:"https://t.me/",
    channel:"https://t.me/",
    exchanger:"https://t.me/",
    jobs:"https://t.me/",
    support:"https://t.me/"
  }
};
const getSettings = db.prepare(`SELECT value_json FROM settings WHERE key=?`);
const upsertSettings = db.prepare(`
  INSERT INTO settings (key, value_json, updated_at)
  VALUES (@key, @value_json, @updated_at)
  ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
`);
const row = getSettings.get('links');
if (!row) {
  upsertSettings.run({
    key:'links',
    value_json: JSON.stringify(defaultLinks),
    updated_at: Date.now()
  });
}

// ====== ТРЕКИНГ ПОСЕЩЕНИЙ ======
// Лёгкий endpoint: принимает только путь/реферер с клиента.
// IP и страну определяем на сервере (по заголовкам от прокси/Cloudflare).
const insertVisit = db.prepare(`
  INSERT INTO visits (ts, ip, ua, country, path, ref) VALUES (?, ?, ?, ?, ?, ?)
`);

function detectCountry(req) {
  // Подхватываем самые распространённые заголовки от прокси/CDN
  return (
    req.headers['cf-ipcountry'] ||
    req.headers['x-vercel-ip-country'] ||
    req.headers['x-country'] ||
    'Unknown'
  );
}

app.post('/api/track', (req, res) => {
  try {
    const ts = Date.now();
    const ip =
      (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      req.socket.remoteAddress ||
      '';
    const ua = req.headers['user-agent'] || '';
    const country = detectCountry(req);
    const { path: p = '/', ref = '' } = req.body || {};
    insertVisit.run(ts, ip, ua, country, p, ref);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false });
  }
});

// ====== API АДМИНКИ ======
function startOfDay(t = Date.now()) {
  const d = new Date(t);
  d.setHours(0,0,0,0); return d.getTime();
}
const now = () => Date.now();

const countByRange = db.prepare(`SELECT COUNT(*) as c FROM visits WHERE ts BETWEEN ? AND ?`);
const topCountries = db.prepare(`
  SELECT country, COUNT(*) as c FROM visits
  WHERE ts BETWEEN ? AND ?
  GROUP BY country ORDER BY c DESC LIMIT 10
`);
const recentVisits = db.prepare(`
  SELECT ts, ip, country, path, ref FROM visits ORDER BY id DESC LIMIT ?
`);

app.get('/api/admin/stats', auth, (req,res) => {
  const end = now();
  const dayStart  = startOfDay(end);
  const weekStart = dayStart - 6*24*3600*1000;
  const monthStart= dayStart - 29*24*3600*1000;
  const allStart  = 0;

  const by = (s,e)=>countByRange.get(s,e).c;
  const stats = {
    day:   { visits: by(dayStart, end),   countries: topCountries.all(dayStart, end) },
    week:  { visits: by(weekStart, end),  countries: topCountries.all(weekStart, end) },
    month: { visits: by(monthStart, end), countries: topCountries.all(monthStart, end) },
    all:   { visits: by(allStart, end),   countries: topCountries.all(allStart, end) }
  };
  res.json(stats);
});

app.get('/api/admin/visits', auth, (req,res) => {
  const limit = Math.min(parseInt(req.query.limit || '100',10), 500);
  res.json(recentVisits.all(limit));
});

app.get('/api/admin/links', auth, (req,res) => {
  const row = getSettings.get('links');
  res.json(row ? JSON.parse(row.value_json) : defaultLinks);
});

function isValidUrl(u) {
  try { new URL(u, 'https://example.com'); return true; } catch { return false; }
}

app.post('/api/admin/links', auth, (req,res) => {
  const payload = req.body || {};
  // простая валидация
  const next = { ...defaultLinks, ...payload };
  if (typeof next.fortune !== 'string') next.fortune = defaultLinks.fortune;
  if (typeof next.job !== 'string') next.job = defaultLinks.job;
  if (!next.buttons) next.buttons = defaultLinks.buttons;

  for (const k of Object.keys(defaultLinks.buttons)) {
    if (typeof next.buttons[k] !== 'string') next.buttons[k] = defaultLinks.buttons[k];
  }

  upsertSettings.run({
    key:'links',
    value_json: JSON.stringify(next),
    updated_at: Date.now()
  });

  res.json({ ok:true });
});

// ====== СТРАНИЦА АДМИНКИ ======
app.get('/admin', auth, (req,res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ====== ТРЕКИНГ-СКРИПТ ======
app.get('/track.js', (req,res) => {
  res.type('application/javascript').send(`
(function(){
  try{
    var data = { path: location.pathname, ref: document.referrer||"" };
    var blob = new Blob([JSON.stringify(data)], {type:"application/json"});
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/track", blob);
    } else {
      fetch("/api/track", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(data)});
    }
  }catch(e){}
})();
  `.trim());
});

// ====== СТАРТ ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server on http://localhost:'+PORT));
