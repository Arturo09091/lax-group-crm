const express = require('express');
const session = require('express-session');
const bcrypt  = require('bcryptjs');
const path    = require('path');
const fs      = require('fs');
const https   = require('https');
const crypto  = require('crypto');

// ── Simple in-memory rate limiter ────────────────────────────────
const loginAttempts = new Map();
function isRateLimited(ip) {
      const now = Date.now();
      const win = 15 * 60 * 1000;
      const max = 10;
      let entry = loginAttempts.get(ip);
      if (!entry || now > entry.resetAt) { entry = { count: 0, resetAt: now + win }; loginAttempts.set(ip, entry); }
      entry.count++;
      return entry.count > max;
}
setInterval(() => { const now = Date.now(); loginAttempts.forEach((v, k) => { if (now > v.resetAt) loginAttempts.delete(k); }); }, 30 * 60 * 1000);

// ── PostgreSQL ───────────────────────────────────────────────────
let pool = null;
if (process.env.DATABASE_URL) {
      const { Pool } = require('pg');
      const sslConfig = process.env.DATABASE_URL.includes('sslmode=require')
        ? { rejectUnauthorized: false }
              : false;
      pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: sslConfig });
      console.log('\uD83D\uDDC4\uFE0F PostgreSQL conectado');
}

const app  = express();
const PORT = process.env.PORT || 3000;
const AUTH_FILE = path.join(__dirname, 'auth.json');
const DATA_DIR  = path.join(__dirname, 'data');
if (!pool) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Middleware ───────────────────────────────────────────────────
app.set('trust proxy', 1);
if (!process.env.SESSION_SECRET) console.warn('\u26A0\uFE0F SESSION_SECRET no configurado');
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: true, limit: '50kb' }));
app.use(session({
      secret: process.env.SESSION_SECRET || 'lf-change-in-prod-2026',
      resave: false,
      saveUninitialized: false,
      cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, secure: 'auto', sameSite: 'lax' },
}));

// ── DB setup ─────────────────────────────────────────────────────
async function initDB() {
      await pool.query(`
          CREATE TABLE IF NOT EXISTS crm_users (
                username TEXT PRIMARY KEY, name TEXT NOT NULL,
                      role TEXT NOT NULL DEFAULT 'client', password_hash TEXT NOT NULL, webhook_key TEXT
                          )
                            `);
      await pool.query(`
          CREATE TABLE IF NOT EXISTS leads (
                id TEXT PRIMARY KEY, username TEXT NOT NULL,
                      data JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
                          )
                            `);
      // Meta Conversions API config per client
  await pool.query(`
      CREATE TABLE IF NOT EXISTS meta_pixel_config (
            username     TEXT PRIMARY KEY,
                  pixel_id     TEXT,
                        access_token TEXT,
                              test_code    TEXT
                                  )
                                    `);
      // Ensure meta_pixel_config columns exist (migration for existing DBs)
  await pool.query(`ALTER TABLE meta_pixel_config ADD COLUMN IF NOT EXISTS pixel_id TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE meta_pixel_config ADD COLUMN IF NOT EXISTS access_token TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE meta_pixel_config ADD COLUMN IF NOT EXISTS test_code TEXT`).catch(()=>{});
  // Ensure unique constraint on username for ON CONFLICT to work
  await pool.query(`ALTER TABLE meta_pixel_config ADD CONSTRAINT meta_pixel_config_username_unique UNIQUE (username)`).catch(()=>{});
      // Stage → Meta event mapping per client
  await pool.query(`
      CREATE TABLE IF NOT EXISTS meta_stage_rules (
            id          SERIAL PRIMARY KEY,
                  username    TEXT NOT NULL,
                        stage_id    TEXT NOT NULL,
                              meta_event  TEXT NOT NULL,
                                    enabled     BOOLEAN DEFAULT true,
                                          UNIQUE(username, stage_id)
                                              )
                                                `);
      // Migrate from auth.json
  const { rows } = await pool.query('SELECT COUNT(*) as c FROM crm_users');
      if (rows[0].c === '0' && fs.existsSync(AUTH_FILE)) {
              const auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
              for (const u of auth.users) {
                        await pool.query(
                                    `INSERT INTO crm_users (username, name, role, password_hash, webhook_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
                                    [u.username, u.name, u.role, u.passwordHash, u.webhookKey || null]
                                  );
              }
              console.log('\u2705 auth.json migrado a PostgreSQL');
      }
}

// ── Storage: users ───────────────────────────────────────────────
async function getUsers() {
      if (pool) {
              const { rows } = await pool.query('SELECT * FROM crm_users');
              return rows.map(r => ({ username: r.username, name: r.name, role: r.role, passwordHash: r.password_hash, webhookKey: r.webhook_key }));
      }
      try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')).users; } catch { return []; }
}
async function findUser(username) {
      if (pool) {
              const { rows } = await pool.query('SELECT * FROM crm_users WHERE username=$1', [username]);
              if (!rows[0]) return null;
              const r = rows[0];
              return { username: r.username, name: r.name, role: r.role, passwordHash: r.password_hash, webhookKey: r.webhook_key };
      }
      try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')).users.find(u => u.username === username); } catch { return null; }
}
async function upsertUser(user) {
      if (pool) {
              await pool.query(
                        `INSERT INTO crm_users (username, name, role, password_hash, webhook_key) VALUES ($1,$2,$3,$4,$5)
                               ON CONFLICT (username) DO UPDATE SET name=$2, role=$3, password_hash=$4, webhook_key=$5`,
                        [user.username, user.name, user.role, user.passwordHash, user.webhookKey || null]
                      );
              return;
      }
      const authData = fs.existsSync(AUTH_FILE) ? JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')) : { users: [] };
      const idx = authData.users.findIndex(u => u.username === user.username);
      if (idx >= 0) authData.users[idx] = user; else authData.users.push(user);
      fs.writeFileSync(AUTH_FILE, JSON.stringify(authData, null, 2));
}
async function deleteUser(username) {
      if (pool) {
              await pool.query('DELETE FROM crm_users WHERE username=$1', [username]);
              await pool.query('DELETE FROM leads WHERE username=$1', [username]);
              await pool.query('DELETE FROM meta_pixel_config WHERE username=$1', [username]);
              await pool.query('DELETE FROM meta_stage_rules WHERE username=$1', [username]);
              return;
      }
      const authData = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
      authData.users = authData.users.filter(u => u.username !== username);
      fs.writeFileSync(AUTH_FILE, JSON.stringify(authData, null, 2));
      const f = path.join(DATA_DIR, `leads_${username}.json`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
}

// ── Storage: leads ───────────────────────────────────────────────
async function readLeads(username) {
      if (pool) {
              const { rows } = await pool.query('SELECT data FROM leads WHERE username=$1 ORDER BY created_at DESC', [username]);
              return rows.map(r => r.data);
      }
      const f = path.join(DATA_DIR, `leads_${username}.json`);
      try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : []; } catch { return []; }
}
async function upsertLead(username, lead) {
      if (pool) {
              await pool.query(
                        `INSERT INTO leads (id, username, data) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET data=$3`,
                        [lead.id, username, lead]
                      );
              return;
      }
      const f = path.join(DATA_DIR, `leads_${username}.json`);
      const leads = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
      const idx = leads.findIndex(l => l.id === lead.id);
      if (idx >= 0) leads[idx] = lead; else leads.unshift(lead);
      fs.writeFileSync(f, JSON.stringify(leads, null, 2));
}
async function deleteLead(username, id) {
      if (pool) { await pool.query('DELETE FROM leads WHERE id=$1 AND username=$2', [id, username]); return; }
      const f = path.join(DATA_DIR, `leads_${username}.json`);
      const leads = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
      fs.writeFileSync(f, JSON.stringify(leads.filter(l => l.id !== id), null, 2));
}
async function leadsCount(username) {
      if (pool) { const { rows } = await pool.query('SELECT COUNT(*) as c FROM leads WHERE username=$1', [username]); return parseInt(rows[0].c); }
      const f = path.join(DATA_DIR, `leads_${username}.json`);
      try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).length : 0; } catch { return 0; }
}
async function leadsCountLast30(username) {
      const since = new Date(); since.setDate(since.getDate() - 30);
      const sinceISO = since.toISOString().split('T')[0];
      if (pool) {
              const { rows } = await pool.query("SELECT COUNT(*) as c FROM leads WHERE username=$1 AND data->>'createdAt' >= $2", [username, sinceISO]);
              return parseInt(rows[0].c);
      }
      const f = path.join(DATA_DIR, `leads_${username}.json`);
      try { const leads = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : []; return leads.filter(l => (l.createdAt || '') >= sinceISO).length; } catch { return 0; }
}

// ── Storage: Meta Pixel Config ───────────────────────────────────
async function getMetaPixelConfig(username) {
      if (pool) {
              const { rows } = await pool.query('SELECT * FROM meta_pixel_config WHERE username=$1', [username]);
              return rows[0] ? { pixelId: rows[0].pixel_id, accessToken: rows[0].access_token, testCode: rows[0].test_code } : null;
      }
      return null;
}
async function upsertMetaPixelConfig(username, pixelId, accessToken, testCode) {
      if (pool) {
              // Use DELETE + INSERT as safe upsert fallback
              await pool.query('DELETE FROM meta_pixel_config WHERE username=$1', [username]);
              await pool.query(
                        'INSERT INTO meta_pixel_config (username, pixel_id, access_token, test_code) VALUES ($1,$2,$3,$4)',
                        [username, pixelId, accessToken, testCode || null]
                      );
      }
}

// ── Storage: Meta Stage Rules ────────────────────────────────────
async function getMetaStageRules(username) {
      if (pool) {
              const { rows } = await pool.query('SELECT * FROM meta_stage_rules WHERE username=$1 ORDER BY id', [username]);
              return rows.map(r => ({ id: r.id, stageId: r.stage_id, metaEvent: r.meta_event, enabled: r.enabled }));
      }
      return [];
}
async function upsertMetaStageRule(username, stageId, metaEvent, enabled) {
      if (pool) {
              await pool.query(
                        `INSERT INTO meta_stage_rules (username, stage_id, meta_event, enabled) VALUES ($1,$2,$3,$4)
                               ON CONFLICT (username, stage_id) DO UPDATE SET meta_event=$3, enabled=$4`,
                        [username, stageId, metaEvent, enabled !== false]
                      );
      }
}
async function deleteMetaStageRule(username, stageId) {
      if (pool) { await pool.query('DELETE FROM meta_stage_rules WHERE username=$1 AND stage_id=$2', [username, stageId]); }
}

// ── Meta Conversions API: fire event ────────────────────────────
function hashSHA256(value) {
      if (!value) return undefined;
      return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

async function fireMetaEvent(cfg, eventName, lead) {
      if (!cfg || !cfg.pixelId || !cfg.accessToken) {
              console.warn('\u26A0\uFE0F Meta Pixel no configurado para este cliente');
              return { ok: false, error: 'Pixel no configurado' };
      }
      const eventTime = Math.floor(Date.now() / 1000);
      const eventId = `crm-${lead.id}-${eventName}-${eventTime}`;

  const userData = {
          client_ip_address: '0.0.0.0',
          client_user_agent: 'LAX-CRM/1.0',
  };
      if (lead.email) userData.em = [hashSHA256(lead.email)];
      if (lead.phone) userData.ph = [hashSHA256(lead.phone.replace(/\D/g, ''))];
      if (lead.name) {
              const parts = lead.name.trim().split(/\s+/);
              userData.fn = [hashSHA256(parts[0])];
              if (parts.length > 1) userData.ln = [hashSHA256(parts.slice(1).join(' '))];
      }

  const payload = {
          data: [{
                    event_name: eventName,
                    event_time: eventTime,
                    event_id: eventId,
                    action_source: 'crm',
                    user_data: userData,
                    custom_data: {
                                currency: 'EUR',
                                value: lead.value || 0,
                                content_name: lead.campaign || lead.source || 'CRM Lead',
                                lead_id: lead.id,
                                status: lead.stage,
                    },
          }],
  };
      if (cfg.testCode) payload.test_event_code = cfg.testCode;

  const body = JSON.stringify(payload);
      const url = `/v19.0/${cfg.pixelId}/events?access_token=${cfg.accessToken}`;

  return new Promise((resolve) => {
          const req = https.request({
                    hostname: 'graph.facebook.com',
                    path: url,
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          }, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                                try {
                                              const parsed = JSON.parse(data);
                                              console.log(`\uD83D\uDCCA Meta CAPI [${eventName}] → ${JSON.stringify(parsed)}`);
                                              resolve({ ok: !parsed.error, result: parsed });
                                } catch { resolve({ ok: false, error: data }); }
                    });
          });
          req.on('error', err => { console.error('Meta CAPI error:', err); resolve({ ok: false, error: err.message }); });
          req.write(body);
          req.end();
  });
}

// ── Bootstrap ────────────────────────────────────────────────────
function uid()  { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function wKey() { return 'wh-' + Math.random().toString(36).slice(2,10) + Math.random().toString(36).slice(2,10); }
function todayISO()    { return new Date().toISOString().split('T')[0]; }
function tomorrowISO() { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().split('T')[0]; }

const SEED_USERS = [
    { username: 'arturo', name: 'Arturo Abellan',  role: 'admin',  passwordHash: '$2b$10$k/qsGAXu6r5of3ahvy16B.2skvQXoKzfswaUDEgLUvr2HzvOvmRdS', webhookKey: null },
    { username: 'hgroup', name: 'H Group',          role: 'client', passwordHash: '$2b$10$cZNqjV966pvuiJkpSgQte.x7Y./51U6O69V8tC6kgkSTxdWbTcjO2', webhookKey: 'hgrp-3xcb2txiapy8sl30' },
    { username: 'lucas',  name: 'paco',             role: 'client', passwordHash: '$2b$10$2ZcgxuxaEDPutsBPd9y9mOWaP0rxT2fkAYCQcVXCrrmxDhUUMUiAq', webhookKey: 'wh-r7xqixhbj9uq2lj7' },
    { username: 'pepe',   name: 'vcbn',             role: 'client', passwordHash: '$2b$10$8iRznQwiC0kjEKTWi6xndOrbaJ.4snPVLPn2EfikROCS33VRC2t7y',  webhookKey: 'wh-9gpod0xglt4twqh5' },
    ];

async function bootstrap() {
      if (pool) await initDB();
      const users = await getUsers();
      if (users.length === 0) {
              for (const u of SEED_USERS) await upsertUser(u);
              console.log(`\n\u2705 ${SEED_USERS.length} cuentas migradas a PostgreSQL\n`);
      } else {
              const admin = SEED_USERS.find(u => u.role === 'admin');
              if (admin) await upsertUser(admin);
      }
}

// ── Auth middleware ───────────────────────────────────────────────
const PUBLIC = ['/login', '/auth/login'];
function requireAuth(req, res, next) {
      if (PUBLIC.includes(req.path)) return next();
      if (req.path.startsWith('/api/webhook/')) return next();
      if (!req.session.authenticated) {
              if (req.path.startsWith('/api/') || req.path.startsWith('/admin/'))
                        return res.status(401).json({ error: 'No autorizado' });
              return res.redirect('/login');
      }
      next();
}
function requireAdmin(req, res, next) {
      if (req.session.role !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
      next();
}

const BLOCKED_PATHS = new Set(['/server.js', '/auth.json', '/package.json', '/package-lock.json', '/railway.json', '/.gitignore', '/.env']);
app.use((req, res, next) => {
      const p = req.path.toLowerCase();
      if (BLOCKED_PATHS.has(p) || p.startsWith('/data/') || p.startsWith('/node_modules/') || p.startsWith('/.'))
              return res.status(404).end();
      next();
});
app.use(requireAuth);
app.use(express.static(path.join(__dirname)));

// ── Auth routes ───────────────────────────────────────────────────
app.post('/auth/login', async (req, res) => {
      const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
      if (isRateLimited(ip)) return res.status(429).json({ ok: false, error: 'Demasiados intentos. Esper\u00E1 15 minutos.' });
      const { username, password } = req.body;
      const user = await findUser(username);
      if (!user || !bcrypt.compareSync(password, user.passwordHash))
              return res.json({ ok: false, error: 'Usuario o contrase\u00F1a incorrectos' });
      req.session.authenticated = true;
      req.session.username = user.username;
      req.session.name     = user.name;
      req.session.role     = user.role;
      res.json({ ok: true, role: user.role, name: user.name });
});
app.get('/auth/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));
app.post('/auth/change-password', async (req, res) => {
      const { currentPassword, newPassword } = req.body;
      const user = await findUser(req.session.username);
      if (!user || !bcrypt.compareSync(currentPassword, user.passwordHash))
              return res.json({ ok: false, error: 'Contrase\u00F1a actual incorrecta' });
      user.passwordHash = bcrypt.hashSync(newPassword, 10);
      await upsertUser(user);
      res.json({ ok: true });
});
app.get('/api/me', (req, res) => {
      if (!req.session.authenticated) return res.status(401).json({ error: 'No autorizado' });
      res.json({ username: req.session.username, name: req.session.name, role: req.session.role });
});

// ── Admin: users ─────────────────────────────────────────────────
app.get('/admin/users', requireAdmin, async (req, res) => {
      const users = await getUsers();
      const result = await Promise.all(users.map(async u => ({
              username: u.username, name: u.name, role: u.role, webhookKey: u.webhookKey,
              leadsCount: await leadsCount(u.username),
              leadsLast30: await leadsCountLast30(u.username),
      })));
      res.json(result);
});
app.post('/admin/users', requireAdmin, async (req, res) => {
      const { username, name, password, role = 'client' } = req.body;
      if (!username || !name || !password) return res.status(400).json({ error: 'Faltan campos' });
      const existing = await findUser(username);
      if (existing) return res.status(409).json({ error: 'El usuario ya existe' });
      const key = wKey();
      await upsertUser({ username, name, role, passwordHash: bcrypt.hashSync(password, 10), webhookKey: key });
      res.json({ ok: true, username, name, role, webhookKey: key });
});
app.delete('/admin/users/:username', requireAdmin, async (req, res) => {
      if (req.params.username === req.session.username)
              return res.status(400).json({ error: 'No pod\u00E9s eliminarte a vos mismo' });
      await deleteUser(req.params.username);
      res.json({ ok: true });
});
app.post('/admin/users/:username/reset-password', requireAdmin, async (req, res) => {
      const user = await findUser(req.params.username);
      if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
      user.passwordHash = bcrypt.hashSync(req.body.newPassword, 10);
      await upsertUser(user);
      res.json({ ok: true });
});

// ── Admin: Meta CAPI config ───────────────────────────────────────
// GET all clients' meta config (admin overview)
app.get('/admin/meta-config', requireAdmin, async (req, res) => {
      const users = await getUsers();
      const clients = users.filter(u => u.role === 'client');
      const result = await Promise.all(clients.map(async u => {
              const cfg = await getMetaPixelConfig(u.username);
              const rules = await getMetaStageRules(u.username);
              return { username: u.username, name: u.name, pixelConfig: cfg, stageRules: rules };
      }));
      res.json(result);
});

// GET single client meta config
app.get('/admin/meta-config/:username', requireAdmin, async (req, res) => {
      const cfg = await getMetaPixelConfig(req.params.username);
      const rules = await getMetaStageRules(req.params.username);
      res.json({ pixelConfig: cfg, stageRules: rules });
});

// Save pixel config for a client
app.post('/admin/meta-config/:username/pixel', requireAdmin, async (req, res) => {
      const { pixelId, accessToken, testCode } = req.body;
      if (!pixelId || !accessToken) return res.status(400).json({ error: 'pixelId y accessToken requeridos' });
      await upsertMetaPixelConfig(req.params.username, pixelId, accessToken, testCode || '');
      res.json({ ok: true });
});

// Save stage → event rule for a client
app.post('/admin/meta-config/:username/rule', requireAdmin, async (req, res) => {
      const { stageId, metaEvent, enabled } = req.body;
      if (!stageId || !metaEvent) return res.status(400).json({ error: 'stageId y metaEvent requeridos' });
      await upsertMetaStageRule(req.params.username, stageId, metaEvent, enabled !== false);
      res.json({ ok: true });
});

// Delete rule
app.delete('/admin/meta-config/:username/rule/:stageId', requireAdmin, async (req, res) => {
      await deleteMetaStageRule(req.params.username, req.params.stageId);
      res.json({ ok: true });
});

// Test fire: manually trigger a Meta event for a client/lead (admin test)
app.post('/admin/meta-config/:username/test-fire', requireAdmin, async (req, res) => {
      const { eventName, leadId } = req.body;
      if (!eventName) return res.status(400).json({ error: 'eventName requerido' });
      const cfg = await getMetaPixelConfig(req.params.username);
      const testLead = leadId
        ? (await readLeads(req.params.username)).find(l => l.id === leadId)
              : { id: 'test-' + Date.now(), name: 'Test Lead', email: 'test@test.com', phone: '600000000', stage: 'test', value: 0 };
      const result = await fireMetaEvent(cfg, eventName, testLead || { id: 'test', name: 'Test', stage: 'test', value: 0 });
      res.json(result);
});

// ── Leads API ─────────────────────────────────────────────────────
app.get('/api/leads', async (req, res) => res.json(await readLeads(req.session.username)));

app.post('/api/leads', async (req, res) => {
      const username = req.session.username;
      const lead = { ...req.body, id: req.body.id || uid() };
      const existing = (await readLeads(username)).find(l => l.id === lead.id);
      const previousStage = existing ? existing.stage : null;
      await upsertLead(username, lead);
      if (lead.stage && lead.stage !== previousStage) {
          const rules = await getMetaStageRules(username);
          const rule = rules.find(r => r.stageId === lead.stage && r.enabled);
          if (rule) {
              const cfg = await getMetaPixelConfig(username);
              fireMetaEvent(cfg, rule.metaEvent, lead).catch(e => console.error('Meta CAPI fire error:', e));
          }
      }
      res.json(lead);
});

// Lead update with Meta CAPI trigger on stage change
app.put('/api/leads/:id', async (req, res) => {
      const username = req.session.username;
      const leads = await readLeads(username);
      const existing = leads.find(l => l.id === req.params.id);
      if (!existing) return res.status(404).json({ error: 'Lead no encontrado' });

          const previousStage = existing.stage;
      const updated = { ...existing, ...req.body, id: req.params.id };
      await upsertLead(username, updated);

          // Check if stage changed → fire Meta CAPI if rule exists
          if (updated.stage && updated.stage !== previousStage) {
                  const rules = await getMetaStageRules(username);
                  const rule = rules.find(r => r.stageId === updated.stage && r.enabled);
                  if (rule) {
                            const cfg = await getMetaPixelConfig(username);
                            fireMetaEvent(cfg, rule.metaEvent, updated).catch(e => console.error('Meta CAPI fire error:', e));
                  }
          }

          res.json(updated);
});

app.delete('/api/leads/:id', async (req, res) => {
      await deleteLead(req.session.username, req.params.id);
      res.json({ ok: true });
});

// ── Make Webhook ──────────────────────────────────────────────────
app.post('/api/webhook/:key', async (req, res) => {
      if (!/^[\w\-]{8,40}$/.test(req.params.key)) return res.status(400).json({ error: 'Key inv\u00E1lida' });
      const users = await getUsers();
      const user = users.find(u => u.webhookKey === req.params.key);
      if (!user) return res.status(404).json({ error: 'Webhook key no v\u00E1lida' });
      const b = req.body;
      const trunc = (s, n) => String(s || '').slice(0, n);
      const lead = {
              id: uid(),
              name: trunc(b.name, 120) || 'Sin nombre',
              phone: trunc(b.phone, 30), email: trunc(b.email, 120),
              source: trunc(b.source, 60) || 'Facebook Ads',
              campaign: trunc(b.campaign, 120), adSet: trunc(b.adSet, 120),
              stage: 'new', notes: trunc(b.notes, 1000),
              createdAt: b.createdAt || todayISO(), followUpDate: tomorrowISO(),
              value: Number(b.value) || 0,
      };
      await upsertLead(user.username, lead);

           // Fire Meta CAPI for 'new' stage if rule exists
           const rules = await getMetaStageRules(user.username);
      const rule = rules.find(r => r.stageId === 'new' && r.enabled);
      if (rule) {
              const cfg = await getMetaPixelConfig(user.username);
              fireMetaEvent(cfg, rule.metaEvent, lead).catch(e => console.error('Meta CAPI webhook fire error:', e));
      }

           console.log(`\uD83D\uDCE5 [Make \u2192 ${user.name}] ${lead.name} | ${lead.phone}`);
      res.json({ ok: true, lead });
});

// ── Pages ─────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
      if (req.session.authenticated) return res.redirect('/');
      res.sendFile(path.join(__dirname, 'login.html'));
});
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'leadflow-crm.html')));

// ── Start ─────────────────────────────────────────────────────────
bootstrap().then(() => {
      app.listen(PORT, () => {
              console.log(`\u2705 LAX Group CRM \u2192 http://localhost:${PORT}`);
              console.log(`\uD83D\uDCE1 Webhooks \u2192 http://localhost:${PORT}/api/webhook/:key`);
      });
}).catch(err => { console.error('Error al arrancar:', err); process.exit(1); });
