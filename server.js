// v3 - pixel config fix + white screen fix
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
// Sesiones persistentes en Postgres (sobreviven a los redeploys; con
// MemoryStore se perdían en cada deploy y obligaban a volver a entrar).
// Si no hay DB, cae al MemoryStore por defecto sin romper nada.
let sessionStore;
if (pool) {
      try {
              const PgSession = require('connect-pg-simple')(session);
              sessionStore = new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true });
      } catch (e) { console.warn('⚠️ connect-pg-simple no disponible, usando MemoryStore:', e.message); }
}
app.use(session({
      store: sessionStore,
      secret: process.env.SESSION_SECRET || 'lf-change-in-prod-2026',
      resave: false,
      saveUninitialized: false,
      rolling: true,  // renueva la caducidad en cada visita (ventana deslizante de 30 días)
      cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, secure: 'auto', sameSite: 'lax' },
}));

// ── DB setup ─────────────────────────────────────────────────────
async function initDB() {
      await pool.query(`
          CREATE TABLE IF NOT EXISTS crm_users (
                username TEXT PRIMARY KEY, name TEXT NOT NULL,
                      role TEXT NOT NULL DEFAULT 'client', password_hash TEXT NOT NULL, webhook_key TEXT
                          )
                            `);
      // Idempotent migration: track password version per user so sessions
      // can be invalidated when the password changes.
      await pool.query(`ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS password_version INTEGER NOT NULL DEFAULT 1`);
      await pool.query(`
          CREATE TABLE IF NOT EXISTS leads (
                id TEXT PRIMARY KEY, username TEXT NOT NULL,
                      data JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
                          )
                            `);
      // Meta Conversions API config per client
  // NUNCA hacer DROP aquí: initDB() corre en CADA arranque, así que un DROP
  // borraba el pixel/token de todos los clientes en cada deploy y la API de
  // Conversiones dejaba de disparar en silencio. La tabla es persistente.
  await pool.query(`
      CREATE TABLE IF NOT EXISTS meta_pixel_config (
            username     TEXT PRIMARY KEY,
                  pixel_id     TEXT,
                        access_token TEXT,
                              test_code    TEXT
                                  )
                                    `);
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
                                                    // Pipeline stage labels per client (custom column headers)
                                                        await pool.query(`
                                                                CREATE TABLE IF NOT EXISTS pipeline_stage_labels (
                                                                            username   TEXT NOT NULL,
                                                                                        stage_id   TEXT NOT NULL,
                                                                                                    label      TEXT NOT NULL,
                                                                                                                PRIMARY KEY (username, stage_id)
                                                                                                                        )
                                                                                                                            `);

      // La migración va protegida: si algo fallara NO puede tumbar el arranque
      // (bootstrap hace process.exit(1) ante cualquier error). En el peor caso
      // el CRM sigue funcionando con las columnas por defecto.
      try {
        // ── Migración: columnas de pipeline ilimitadas ───────────────────────
        // Aditiva e idempotente. No borra ni una fila; solo añade campos y
        // rellena los que faltan preservando EXACTAMENTE el orden visual actual.
        await pool.query('ALTER TABLE pipeline_stage_labels ADD COLUMN IF NOT EXISTS "position" INTEGER');
        await pool.query('ALTER TABLE pipeline_stage_labels ADD COLUMN IF NOT EXISTS color TEXT');
        await pool.query('ALTER TABLE pipeline_stage_labels ADD COLUMN IF NOT EXISTS is_won BOOLEAN NOT NULL DEFAULT false');
        await pool.query('ALTER TABLE pipeline_stage_labels ADD COLUMN IF NOT EXISTS is_lost BOOLEAN NOT NULL DEFAULT false');
        await pool.query('ALTER TABLE pipeline_stage_labels ADD COLUMN IF NOT EXISTS is_entry BOOLEAN NOT NULL DEFAULT false');
        await pool.query(`UPDATE pipeline_stage_labels SET "position" = CASE stage_id
                WHEN 'new' THEN 0 WHEN 'contacted' THEN 1 WHEN 'following' THEN 2
                WHEN 'proposal' THEN 3 WHEN 'converted' THEN 4 WHEN 'lost' THEN 5
                ELSE 99 END WHERE "position" IS NULL`);
        await pool.query(`UPDATE pipeline_stage_labels SET color = CASE stage_id
                WHEN 'new' THEN '#3b82f6' WHEN 'contacted' THEN '#eab308' WHEN 'following' THEN '#f97316'
                WHEN 'proposal' THEN '#a855f7' WHEN 'converted' THEN '#22c55e' WHEN 'lost' THEN '#ef4444'
                ELSE '#64748b' END WHERE color IS NULL`);
        await pool.query("UPDATE pipeline_stage_labels SET is_won=true   WHERE stage_id='converted' AND is_won=false");
        await pool.query("UPDATE pipeline_stage_labels SET is_lost=true  WHERE stage_id='lost'      AND is_lost=false");
        await pool.query("UPDATE pipeline_stage_labels SET is_entry=true WHERE stage_id='new'       AND is_entry=false");
        // Índice: con miles de leads por cliente, readLeads y el guard de borrado lo agradecen
        await pool.query('CREATE INDEX IF NOT EXISTS idx_leads_username ON leads(username)');
      } catch (e) {
        console.error("⚠️  Migración de columnas de pipeline NO aplicada:", e.message);
      }
      // Plantilla de mensaje de WhatsApp por cliente (configurable por el admin)
      await pool.query(`CREATE TABLE IF NOT EXISTS whatsapp_templates (
              username TEXT PRIMARY KEY,
              template TEXT NOT NULL
          )`);
      // Elección de app por cliente: 'normal' | 'business' (por defecto 'normal' = comportamiento actual)
      await pool.query(`ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS wa_app TEXT NOT NULL DEFAULT 'normal'`);
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
              return rows.map(r => ({ username: r.username, name: r.name, role: r.role, passwordHash: r.password_hash, webhookKey: r.webhook_key, passwordVersion: r.password_version }));
      }
      try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')).users; } catch { return []; }
}
async function findUser(username) {
      if (pool) {
              const { rows } = await pool.query('SELECT * FROM crm_users WHERE username=$1', [username]);
              if (!rows[0]) return null;
              const r = rows[0];
              return { username: r.username, name: r.name, role: r.role, passwordHash: r.password_hash, webhookKey: r.webhook_key, passwordVersion: r.password_version };
      }
      try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')).users.find(u => u.username === username); } catch { return null; }
}
// Cheap lookup used by requireAuth on every request to verify the session
// hasn't been invalidated by a password change. Returns null if user gone.
async function getUserPasswordVersion(username) {
      if (!pool) return 1; // file-based fallback has no versioning
      const { rows } = await pool.query('SELECT password_version FROM crm_users WHERE username=$1', [username]);
      return rows[0] ? rows[0].password_version : null;
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
// Atomically updates the password hash AND bumps password_version.
// Returns the new version number so callers (self-change) can sync their
// own session and stay logged in on this device.
async function changePassword(username, newPasswordHash) {
      if (!pool) {
              // file-based fallback: just write hash, no versioning
              const u = await findUser(username);
              if (!u) return null;
              u.passwordHash = newPasswordHash;
              await upsertUser(u);
              return 1;
      }
      const { rows } = await pool.query(
              `UPDATE crm_users SET password_hash=$2, password_version=password_version+1
               WHERE username=$1 RETURNING password_version`,
              [username, newPasswordHash]
      );
      return rows[0] ? rows[0].password_version : null;
}

async function deleteUser(username) {
      if (pool) {
              await pool.query('DELETE FROM crm_users WHERE username=$1', [username]);
              await pool.query('DELETE FROM leads WHERE username=$1', [username]);
              await pool.query('DELETE FROM meta_pixel_config WHERE username=$1', [username]);
              await pool.query('DELETE FROM meta_stage_rules WHERE username=$1', [username]);
                          await pool.query('DELETE FROM pipeline_stage_labels WHERE username=$1', [username]);
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

// -- Storage: Pipeline Stages (columnas del pipeline, ilimitadas por cliente) ─
// Los ids 'new', 'converted' y 'lost' son del sistema: se pueden renombrar,
// recolorear y reordenar, pero NO borrar. Sostienen la etapa de entrada de los
// leads (webhook de Make) y las métricas de conversión/pérdida de los informes.
const STAGE_DEFAULTS = [
      { id: 'new',       label: 'Nuevo Lead',        position: 0, color: '#3b82f6', isWon: false, isLost: false, isEntry: true  },
      { id: 'contacted', label: 'Contactado',        position: 1, color: '#eab308', isWon: false, isLost: false, isEntry: false },
      { id: 'following', label: 'En Seguimiento',    position: 2, color: '#f97316', isWon: false, isLost: false, isEntry: false },
      { id: 'proposal',  label: 'Propuesta Enviada', position: 3, color: '#a855f7', isWon: false, isLost: false, isEntry: false },
      { id: 'converted', label: 'Convertido',        position: 4, color: '#22c55e', isWon: true,  isLost: false, isEntry: false },
      { id: 'lost',      label: 'Perdido',           position: 5, color: '#ef4444', isWon: false, isLost: true,  isEntry: false },
];
const PROTECTED_STAGE_IDS = ['new', 'converted', 'lost'];
const MAX_STAGES  = 30;
const STAGE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const HEX_RE      = /^#[0-9a-fA-F]{6}$/;

async function getPipelineStages(username) {
      if (!pool) return STAGE_DEFAULTS.map(s => ({ ...s }));
      const { rows } = await pool.query(
              `SELECT stage_id, label, "position", color, is_won, is_lost, is_entry
                 FROM pipeline_stage_labels WHERE username=$1
                ORDER BY "position" NULLS LAST, stage_id`,
              [username]
      );
      if (!rows.length) return STAGE_DEFAULTS.map(s => ({ ...s }));
      return rows.map((r, i) => ({
              id:       r.stage_id,
              label:    r.label,
              position: r.position == null ? i : r.position,
              color:    HEX_RE.test(String(r.color || '')) ? r.color : '#64748b',
              isWon:    r.is_won   === true,
              isLost:   r.is_lost  === true,
              isEntry:  r.is_entry === true,
      }));
}
// Alias retrocompatible (lo usan /admin/meta-config y /admin/pipeline-stages).
const getPipelineStageLabels = getPipelineStages;

// La etapa de entrada de los leads nuevos (webhook, alta manual).
async function getEntryStageId(username) {
      try {
              const stages = await getPipelineStages(username);
              const entry = stages.find(s => s.isEntry) || stages[0];
              return entry ? entry.id : 'new';
      } catch { return 'new'; }
}

// Valida la lista entrante. Las banderas ganada/perdida/entrada las DERIVA el
// servidor de los ids del sistema: nunca se aceptan desde el navegador, así
// las métricas de conversión no se pueden romper desde el cliente.
function validateStages(input) {
      if (!Array.isArray(input) || input.length === 0) return { ok: false, error: 'Se requiere una lista de etapas' };
      if (input.length > MAX_STAGES) return { ok: false, error: `Máximo ${MAX_STAGES} columnas` };
      const seen = new Set();
      const out  = [];
      for (let i = 0; i < input.length; i++) {
              const raw = input[i] || {};
              const id  = String(raw.id || '').trim().toLowerCase();
              if (!STAGE_ID_RE.test(id)) return { ok: false, error: `Identificador inválido: "${id}"` };
              if (seen.has(id))          return { ok: false, error: `Identificador duplicado: "${id}"` };
              seen.add(id);
              const label = String(raw.label || '').trim();
              if (!label || label.length > 40) return { ok: false, error: `Nombre inválido en "${id}" (1 a 40 caracteres)` };
              const color = HEX_RE.test(String(raw.color || '')) ? String(raw.color).toLowerCase() : '#64748b';
              out.push({
                      id, label, color, position: i,
                      isWon:   id === 'converted',
                      isLost:  id === 'lost',
                      isEntry: id === 'new',
              });
      }
      for (const p of PROTECTED_STAGE_IDS) {
              if (!seen.has(p)) return { ok: false, error: `La columna "${p}" es del sistema y no se puede eliminar` };
      }
      return { ok: true, stages: out };
}

// Guarda la lista COMPLETA en una sola transacción.
// Nunca reasigna leads: si una columna a borrar aún tiene leads, se rechaza
// entera (409) y no se toca absolutamente nada.
async function savePipelineStages(username, stages) {
      if (!pool) return { ok: true, stages, deletedRules: 0 };
      const client = await pool.connect();
      try {
              await client.query('BEGIN');
              const { rows: cur } = await client.query(
                      'SELECT stage_id FROM pipeline_stage_labels WHERE username=$1 FOR UPDATE', [username]
              );
              const incoming = new Set(stages.map(s => s.id));
              const removed  = cur.map(r => r.stage_id).filter(id => !incoming.has(id));

              if (removed.length) {
                      const { rows: used } = await client.query(
                              `SELECT data->>'stage' AS stage, COUNT(*)::int AS c
                                 FROM leads WHERE username=$1 AND data->>'stage' = ANY($2::text[])
                                GROUP BY 1`,
                              [username, removed]
                      );
                      if (used.length) {
                              await client.query('ROLLBACK');
                              return {
                                      ok: false, status: 409,
                                      error: 'Hay leads en columnas que quieres borrar. Muévelos primero.',
                                      blocked: used.map(u => ({ stage: u.stage, count: u.c })),
                              };
                      }
              }

              for (const s of stages) {
                      await client.query(
                              `INSERT INTO pipeline_stage_labels (username, stage_id, label, "position", color, is_won, is_lost, is_entry)
                               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                               ON CONFLICT (username, stage_id) DO UPDATE
                                 SET label=$3, "position"=$4, color=$5, is_won=$6, is_lost=$7, is_entry=$8`,
                              [username, s.id, s.label, s.position, s.color, s.isWon, s.isLost, s.isEntry]
                      );
              }

              let deletedRules = 0;
              if (removed.length) {
                      await client.query('DELETE FROM pipeline_stage_labels WHERE username=$1 AND stage_id = ANY($2::text[])', [username, removed]);
                      const del = await client.query('DELETE FROM meta_stage_rules WHERE username=$1 AND stage_id = ANY($2::text[])', [username, removed]);
                      deletedRules = del.rowCount || 0;
              }
              await client.query('COMMIT');
              return { ok: true, stages, deletedRules };
      } catch (e) {
              await client.query('ROLLBACK').catch(() => {});
              throw e;
      } finally {
              client.release();
      }
}


// ── WhatsApp message template per client ─────────────────────────
const DEFAULT_WA_TEMPLATE = 'Hola {nombre}, te contactamos por tu consulta. ¿Cómo estás?';
async function getWhatsappTemplate(username) {
      if (!pool) return DEFAULT_WA_TEMPLATE;
      const { rows } = await pool.query('SELECT template FROM whatsapp_templates WHERE username=$1', [username]);
      return rows[0] && rows[0].template ? rows[0].template : DEFAULT_WA_TEMPLATE;
}
async function setWhatsappTemplate(username, template) {
      if (!pool) return;
      await pool.query(
              `INSERT INTO whatsapp_templates (username, template) VALUES ($1,$2)
               ON CONFLICT (username) DO UPDATE SET template=$2`,
              [username, template]
      );
}
// Config completa: plantilla + app elegida ('normal' | 'business').
async function getWhatsappConfig(username) {
      if (!pool) return { template: DEFAULT_WA_TEMPLATE, waApp: 'normal' };
      const { rows } = await pool.query('SELECT template, wa_app FROM whatsapp_templates WHERE username=$1', [username]);
      return {
              template: rows[0] && rows[0].template ? rows[0].template : DEFAULT_WA_TEMPLATE,
              waApp:    rows[0] && rows[0].wa_app === 'business' ? 'business' : 'normal',
      };
}
async function setWhatsappConfig(username, template, waApp) {
      if (!pool) return;
      const app = waApp === 'business' ? 'business' : 'normal';
      await pool.query(
              `INSERT INTO whatsapp_templates (username, template, wa_app) VALUES ($1,$2,$3)
               ON CONFLICT (username) DO UPDATE SET template=$2, wa_app=$3`,
              [username, template, app]
      );
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
              // Re-create the seed admin ONLY if it doesn't exist anymore
              // (e.g. accidental deletion). Never overwrite an existing
              // admin row \u2014 that would reset their password to the hardcoded
              // hash on every deploy.
              const admin = SEED_USERS.find(u => u.role === 'admin');
              if (admin && !(await findUser(admin.username))) {
                      await upsertUser(admin);
                      console.log(`\n\u2705 Admin seed re-creado: ${admin.username}\n`);
              }
      }
}

// ── Auth middleware ───────────────────────────────────────────────
const PUBLIC = ['/login', '/auth/login', '/logo.png', '/favicon.ico'];
async function requireAuth(req, res, next) {
      if (PUBLIC.includes(req.path)) return next();
      if (req.path.startsWith('/vendor/')) return next(); // public static libs (react/babel/tailwind)
      if (req.path.startsWith('/api/webhook/')) return next();
      if (!req.session.authenticated) {
              if (req.path.startsWith('/api/') || req.path.startsWith('/admin/'))
                        return res.status(401).json({ error: 'No autorizado' });
              return res.redirect('/login');
      }
      // Validate session against current password_version in DB. If the
      // password has been changed since this session was issued, kill it.
      if (req.session.username && req.session.passwordVersion != null) {
              try {
                        const currentVersion = await getUserPasswordVersion(req.session.username);
                        if (currentVersion == null || currentVersion !== req.session.passwordVersion) {
                                  return req.session.destroy(() => {
                                          if (req.path.startsWith('/api/') || req.path.startsWith('/admin/'))
                                                  return res.status(401).json({ error: 'Sesión expirada — contraseña cambiada' });
                                          res.redirect('/login');
                                  });
                        }
              } catch (e) {
                        // DB hiccup: don't lock people out, just continue
                        console.warn('requireAuth: password_version check failed', e.message);
              }
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
      // Soporta dos modos sin romper nada:
      //  \u00B7 formulario nativo (urlencoded) \u2192 redirige (el navegador ofrece
      //    guardar la contrase\u00F1a y la autocompleta en el pr\u00F3ximo inicio)
      //  \u00B7 JSON (fetch) \u2192 respuesta JSON (compatibilidad)
      const wantsJson = !!req.is('json');
      const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
      if (isRateLimited(ip))
              return wantsJson
                      ? res.status(429).json({ ok: false, error: 'Demasiados intentos. Espera 15 minutos.' })
                      : res.redirect('/login?e=rate');
      const { username, password } = req.body;
      const user = await findUser(username);
      if (!user || !bcrypt.compareSync(password, user.passwordHash))
              return wantsJson
                      ? res.json({ ok: false, error: 'Usuario o contrase\u00F1a incorrectos' })
                      : res.redirect('/login?e=bad');
      req.session.authenticated = true;
      req.session.username = user.username;
      req.session.name     = user.name;
      req.session.role     = user.role;
      req.session.passwordVersion = user.passwordVersion ?? 1;
      if (wantsJson) return res.json({ ok: true, role: user.role, name: user.name });
      // Guardamos la sesi\u00F3n antes de la navegaci\u00F3n para que la cookie viaje.
      req.session.save(() => res.redirect('/'));
});
app.get('/auth/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));
app.post('/auth/change-password', async (req, res) => {
      const { currentPassword, newPassword } = req.body;
      const user = await findUser(req.session.username);
      if (!user || !bcrypt.compareSync(currentPassword, user.passwordHash))
              return res.json({ ok: false, error: 'Contrase\u00F1a actual incorrecta' });
      const newPwd = String(newPassword || '').trim();
      if (newPwd.length < 4) return res.json({ ok: false, error: 'Contrase\u00F1a m\u00EDnimo 4 caracteres' });
      const newVersion = await changePassword(user.username, bcrypt.hashSync(newPwd, 10));
      // Self-change: sync this session's version so we don't auto-logout
      // here, but every OTHER device with the old version gets kicked out.
      if (newVersion != null) req.session.passwordVersion = newVersion;
      res.json({ ok: true });
});
app.get('/api/me', (req, res) => {
      if (!req.session.authenticated) return res.status(401).json({ error: 'No autorizado' });
      res.json({
              username: req.session.username,
              name: req.session.name,
              role: req.session.role,
              impersonatedBy: req.session.originalAdmin
                      ? { username: req.session.originalAdmin.username, name: req.session.originalAdmin.name }
                      : null,
      });
});

// ── Admin: impersonation (ver como cliente sin cerrar sesión) ──
app.post('/admin/impersonate/:username', async (req, res) => {
      // Authoritative admin check: either current session is admin,
      // or it's already an impersonation session whose ORIGINAL admin is admin.
      const actingAdmin = req.session.originalAdmin || (req.session.role === 'admin' ? {
              username: req.session.username, name: req.session.name, role: req.session.role,
              passwordVersion: req.session.passwordVersion,
      } : null);
      if (!actingAdmin || actingAdmin.role !== 'admin')
              return res.status(403).json({ error: 'Solo administradores' });

      const target = await findUser(req.params.username);
      if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });
      if (target.role === 'admin')
              return res.status(400).json({ error: 'No podés impersonar a otro admin' });
      if (target.username === actingAdmin.username)
              return res.status(400).json({ error: 'No podés impersonarte a vos mismo' });

      req.session.originalAdmin = actingAdmin;
      req.session.username = target.username;
      req.session.name     = target.name;
      req.session.role     = target.role;
      req.session.passwordVersion = target.passwordVersion ?? 1;
      res.json({ ok: true, viewingAs: { username: target.username, name: target.name } });
});

app.post('/admin/stop-impersonating', (req, res) => {
      if (!req.session.originalAdmin)
              return res.status(400).json({ error: 'No estás impersonando a nadie' });
      const admin = req.session.originalAdmin;
      req.session.username = admin.username;
      req.session.name     = admin.name;
      req.session.role     = admin.role;
      if (admin.passwordVersion != null) req.session.passwordVersion = admin.passwordVersion;
      delete req.session.originalAdmin;
      res.json({ ok: true });
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
      const cleanPwd = String(password || '').trim();
      if (!username || !name || !cleanPwd) return res.status(400).json({ error: 'Faltan campos' });
      if (cleanPwd.length < 4) return res.status(400).json({ error: 'Contraseña mínimo 4 caracteres' });
      const existing = await findUser(username);
      if (existing) return res.status(409).json({ error: 'El usuario ya existe' });
      const key = wKey();
      await upsertUser({ username, name, role, passwordHash: bcrypt.hashSync(cleanPwd, 10), webhookKey: key });
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
      const newPwd = String(req.body.newPassword || '').trim();
      if (newPwd.length < 4) return res.status(400).json({ error: 'Contraseña mínimo 4 caracteres' });
      const newVersion = await changePassword(user.username, bcrypt.hashSync(newPwd, 10));
      // If admin happens to reset their OWN password from here, keep this
      // device alive. For any other user, version bump kicks out their
      // existing sessions on the next request.
      if (newVersion != null && req.session.username === user.username && !req.session.originalAdmin)
              req.session.passwordVersion = newVersion;
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
                      const stageLabels = await getPipelineStageLabels(u.username);
              return { username: u.username, name: u.name, pixelConfig: cfg, stageRules: rules , stageLabels };
      }));
      res.json(result);
});

// GET single client meta config
app.get('/admin/meta-config/:username', requireAdmin, async (req, res) => {
      const cfg = await getMetaPixelConfig(req.params.username);
      const rules = await getMetaStageRules(req.params.username);
              const stageLabels = await getPipelineStageLabels(req.params.username);
      res.json({ pixelConfig: cfg, stageRules: rules , stageLabels });
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

// -- Pipeline Stages API (client: read & save custom column labels) ────────────
// GET /api/pipeline-stages → [{id,label,position,color,isWon,isLost,isEntry}]
// Retrocompatible: el front antiguo solo lee id y label.
app.get('/api/pipeline-stages', async (req, res) => {
      try {
              res.json(await getPipelineStages(req.session.username));
      } catch (e) {
              console.error('pipeline-stages GET error:', e);
              res.status(500).json({ error: 'Error interno' });
      }
});

// PUT /api/pipeline-stages  body: [{id,label,color}, ...] (o {stages:[...]})
// Guarda la lista COMPLETA de columnas del cliente.
app.put('/api/pipeline-stages', async (req, res) => {
      try {
              const input = Array.isArray(req.body) ? req.body : (req.body && req.body.stages);
              const v = validateStages(input);
              if (!v.ok) return res.status(400).json({ error: v.error });
              const r = await savePipelineStages(req.session.username, v.stages);
              if (!r.ok) return res.status(r.status || 409).json({ error: r.error, blocked: r.blocked || [] });
              res.json({ ok: true, stages: r.stages, deletedRules: r.deletedRules || 0 });
      } catch (e) {
              console.error('pipeline-stages PUT error:', e);
              res.status(500).json({ error: 'Error interno' });
      }
});


                                                                                                        // GET /admin/pipeline-stages/:username
                                                                                                        app.get('/admin/pipeline-stages/:username', requireAdmin, async (req, res) => {
                                                                                                            try {
                                                                                                                    const labels = await getPipelineStageLabels(req.params.username);
                                                                                                                            res.json(labels);
                                                                                                                                } catch (e) {
                                                                                                                                        res.status(500).json({ error: 'Error interno' });
                                                                                                                                            }
                                                                                                                                            });


// ── WhatsApp templates API ───────────────────────────────────────
// Cliente: lee SU propia plantilla (la usa el botón de WhatsApp del CRM).
app.get('/api/whatsapp-template', async (req, res) => {
      try {
              res.json(await getWhatsappConfig(req.session.username));
      } catch (e) {
              console.error('whatsapp-template GET error:', e);
              res.json({ template: DEFAULT_WA_TEMPLATE, waApp: 'normal' });
      }
});
// Admin: lista de clientes con su plantilla y app elegida.
app.get('/admin/whatsapp-templates', requireAdmin, async (req, res) => {
      try {
              const users = await getUsers();
              const clients = users.filter(u => u.role === 'client');
              const result = await Promise.all(clients.map(async u => {
                      const cfg = await getWhatsappConfig(u.username);
                      return { username: u.username, name: u.name, template: cfg.template, waApp: cfg.waApp };
              }));
              res.json({ default: DEFAULT_WA_TEMPLATE, clients: result });
      } catch (e) {
              console.error('admin whatsapp-templates GET error:', e);
              res.status(500).json({ error: 'Error interno' });
      }
});
// Admin: guarda la plantilla y la app (normal/business) de un cliente.
app.post('/admin/whatsapp-templates/:username', requireAdmin, async (req, res) => {
      try {
              const user = await findUser(req.params.username);
              if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
              const tpl = String(req.body.template || '').trim();
              if (!tpl) return res.status(400).json({ error: 'El mensaje no puede estar vacío' });
              if (tpl.length > 1000) return res.status(400).json({ error: 'Mensaje demasiado largo' });
              const waApp = req.body.waApp === 'business' ? 'business' : 'normal';
              await setWhatsappConfig(user.username, tpl, waApp);
              res.json({ ok: true });
      } catch (e) {
              console.error('admin whatsapp-templates POST error:', e);
              res.status(500).json({ error: 'Error interno' });
      }
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
              adName: trunc(b.adName || b.ad_name || b.utm_ad || b.ad || b.anuncio || b.utm_content, 120),
              stage: await getEntryStageId(user.username), notes: trunc(b.notes, 1000),
              createdAt: b.createdAt || todayISO(), followUpDate: tomorrowISO(),
              value: Number(b.value) || 0,
      };
      await upsertLead(user.username, lead);

           // Fire Meta CAPI for 'new' stage if rule exists
           const rules = await getMetaStageRules(user.username);
      const rule = rules.find(r => r.stageId === lead.stage && r.enabled);
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

// ── Aviso diario de seguimientos por correo ───────────────────────
const followupNotifier = require('./followup-notifier');
const notifierDeps = { pool, getUsers, getPipelineStages, getWhatsappTemplate };

// ── Ajustes de aviso de CADA CLIENTE (su propio correo y horario) ──
// Nota: si el admin está impersonando, req.session.username es el del cliente,
// así que puede configurarlo por él entrando con "Ver como".
app.get('/api/notification-settings', async (req, res) => {
      try {
              const s = await followupNotifier.getSettings(pool, req.session.username);
              res.json({ ...s, emails: s.emails.join(', '), configurado: !!process.env.RESEND_API_KEY });
      } catch (e) {
              console.error('notification-settings GET error:', e);
              res.status(500).json({ error: 'Error interno' });
      }
});

app.put('/api/notification-settings', async (req, res) => {
      try {
              const v = followupNotifier.validateSettings(req.body);
              if (!v.ok) return res.status(400).json({ error: v.error });
              await followupNotifier.saveSettings(pool, req.session.username, v.settings);
              res.json({ ok: true, ...v.settings, emails: v.settings.emails.join(', ') });
      } catch (e) {
              console.error('notification-settings PUT error:', e);
              res.status(500).json({ error: 'Error interno' });
      }
});

// Prueba: envía el aviso ahora mismo a los correos guardados
app.post('/api/notification-settings/test', async (req, res) => {
      try {
              if (!process.env.RESEND_API_KEY) return res.status(400).json({ error: 'El envío de correo no está configurado' });
              const s = await followupNotifier.getSettings(pool, req.session.username);
              if (!s.emails.length) return res.status(400).json({ error: 'Guarda primero un correo' });
              const r = await followupNotifier.sendClientDigest(notifierDeps, req.session.username, s, { force: true });
              res.json({ ok: true, enviadoA: r.to, totalHoy: r.totalToday, totalVencidos: r.totalOverdue });
      } catch (e) {
              console.error('notification-settings test error:', e);
              res.status(500).json({ error: e.message || 'Error al enviar' });
      }
});

// Admin: ver qué se enviaría ahora mismo (NO envía nada)
app.get('/admin/followup-preview', requireAdmin, async (req, res) => {
      try {
              const d = await followupNotifier.collectFollowUps(notifierDeps);
              res.json({
                      configurado: !!process.env.RESEND_API_KEY,
                      destinatario: followupNotifier.TO_EMAIL,
                      hora: followupNotifier.NOTIFY_HOUR,
                      zona: followupNotifier.TZ,
                      hoy: d.today, totalHoy: d.totalToday, totalVencidos: d.totalOverdue,
                      clientes: d.clients.map(c => ({ nombre: c.name, hoy: c.today.length, vencidos: c.overdue.length })),
              });
      } catch (e) {
              console.error('followup-preview error:', e);
              res.status(500).json({ error: 'Error interno' });
      }
});

// Admin: enviar el aviso AHORA (prueba manual)
app.post('/admin/followup-test', requireAdmin, async (req, res) => {
      try {
              if (!process.env.RESEND_API_KEY) {
                      return res.status(400).json({ error: 'Falta configurar RESEND_API_KEY en Railway' });
              }
              const r = await followupNotifier.sendDigest(notifierDeps, { force: true });
              res.json({ ok: true, enviadoA: r.to, asunto: r.subject, totalHoy: r.totalToday, totalVencidos: r.totalOverdue });
      } catch (e) {
              console.error('followup-test error:', e);
              res.status(500).json({ error: e.message || 'Error al enviar' });
      }
});


// ── Start ─────────────────────────────────────────────────────────
bootstrap().then(() => {
      app.listen(PORT, () => {
              console.log(`\u2705 LAX Group CRM \u2192 http://localhost:${PORT}`);
              console.log(`\uD83D\uDCE1 Webhooks \u2192 http://localhost:${PORT}/api/webhook/:key`);
      });
      // El programador no puede tumbar el arranque bajo ningún concepto
      try { followupNotifier.startScheduler(notifierDeps); }
      catch (e) { console.error('\u26A0\uFE0F  Programador de avisos no iniciado:', e.message); }
}).catch(err => { console.error('Error al arrancar:', err); process.exit(1); });
