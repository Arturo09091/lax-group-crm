// ─────────────────────────────────────────────────────────────────────────────
// Avisos de seguimientos por correo.
//
// Dos cosas distintas:
//   1) AVISO POR CLIENTE — cada cuenta configura desde su panel su correo (o
//      varios), la hora y si quiere ver también los vencidos. Recibe SOLO sus
//      propios leads, con botones para llamar o escribir por WhatsApp desde el
//      propio correo.
//   2) RESUMEN DEL ADMIN — un único correo a Arturo con todos los clientes.
//
// No añade dependencias: usa el https nativo contra la API de Resend.
// ─────────────────────────────────────────────────────────────────────────────
const https = require('https');

const TZ          = process.env.NOTIFY_TZ    || 'Europe/Madrid';
const NOTIFY_HOUR = parseInt(process.env.NOTIFY_HOUR || '11', 10);
const TO_EMAIL    = process.env.NOTIFY_EMAIL || 'yo@arturoabellan.com';
const FROM_EMAIL  = process.env.RESEND_FROM  || 'LAX Group CRM <onboarding@resend.dev>';
const CRM_URL     = process.env.CRM_URL      || 'https://laxcrm.up.railway.app';
// El resumen del ADMIN no incluye vencidos (hay miles arrastrados y sólo hacían
// ruido). Cada cliente decide por su cuenta en sus propios ajustes.
const INCLUDE_OVERDUE = process.env.NOTIFY_INCLUDE_OVERDUE === 'true';

// ── Fechas en la zona horaria del negocio (el servidor va en UTC) ────────────
function todayIn(tz) {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function hourIn(tz) {
      return parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date()), 10);
}
function isWeekend(iso) {
      const [y, m, d] = iso.split('-').map(Number);
      const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();   // 0 dom, 6 sáb
      return wd === 0 || wd === 6;
}
const fmtEs = iso => { const [y, m, d] = String(iso).split('-'); return `${d}/${m}/${y}`; };
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

// Teléfono → dígitos para wa.me (misma lógica que el CRM)
function waDigits(raw) {
      let d = String(raw || '').replace(/\D/g, '');
      if (!d) return '';
      if (d.startsWith('00')) d = d.slice(2);
      if (d.length === 9 && /^[6789]/.test(d)) d = '34' + d;
      return d;
}

// ── Envío vía Resend ─────────────────────────────────────────────────────────
function sendViaResend(to, subject, html, replyTo) {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) return Promise.reject(new Error('RESEND_API_KEY no configurada'));
      const body = JSON.stringify({
              from: FROM_EMAIL,
              to: Array.isArray(to) ? to : [to],
              reply_to: replyTo || TO_EMAIL,
              subject, html,
      });
      return new Promise((resolve, reject) => {
              const req = https.request({
                      hostname: 'api.resend.com', path: '/emails', method: 'POST',
                      headers: {
                              'Authorization': `Bearer ${apiKey}`,
                              'Content-Type': 'application/json',
                              'Content-Length': Buffer.byteLength(body),
                      },
              }, res => {
                      let data = '';
                      res.on('data', c => data += c);
                      res.on('end', () => {
                              if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data || '{}'));
                              else reject(new Error(`Resend ${res.statusCode}: ${data}`));
                      });
              });
              req.on('error', reject);
              req.setTimeout(30000, () => { req.destroy(); reject(new Error('Resend: tiempo de espera agotado')); });
              req.write(body);
              req.end();
      });
}

// ── Ajustes de aviso por cliente ─────────────────────────────────────────────
const DEFAULT_SETTINGS = { enabled: false, emails: [], includeOverdue: false, hour: 9, weekdaysOnly: true };
const EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const MAX_EMAILS = 5;

async function ensureTables(pool) {
      if (!pool) return;
      await pool.query(`CREATE TABLE IF NOT EXISTS notification_settings (
              username        TEXT PRIMARY KEY,
              enabled         BOOLEAN NOT NULL DEFAULT false,
              emails          TEXT    NOT NULL DEFAULT '',
              include_overdue BOOLEAN NOT NULL DEFAULT false,
              hour            INTEGER NOT NULL DEFAULT 9,
              weekdays_only   BOOLEAN NOT NULL DEFAULT true,
              updated_at      TIMESTAMPTZ DEFAULT NOW()
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS notification_log (
              kind TEXT NOT NULL, sent_date DATE NOT NULL, sent_at TIMESTAMPTZ DEFAULT NOW(),
              PRIMARY KEY (kind, sent_date))`);
}

const rowToSettings = r => ({
      enabled: r.enabled === true,
      emails: String(r.emails || '').split(',').map(s => s.trim()).filter(Boolean),
      includeOverdue: r.include_overdue === true,
      hour: Number.isInteger(r.hour) ? r.hour : 9,
      weekdaysOnly: r.weekdays_only !== false,
});

async function getSettings(pool, username) {
      if (!pool) return { ...DEFAULT_SETTINGS };
      await ensureTables(pool);
      const { rows } = await pool.query('SELECT * FROM notification_settings WHERE username=$1', [username]);
      return rows.length ? rowToSettings(rows[0]) : { ...DEFAULT_SETTINGS };
}

// Valida y normaliza lo que llega del navegador. Nunca se guarda nada a medias.
function validateSettings(input) {
      const raw = String(input?.emails ?? '');
      const emails = raw.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
      if (emails.length > MAX_EMAILS) return { ok: false, error: `Máximo ${MAX_EMAILS} correos` };
      for (const e of emails) if (!EMAIL_RE.test(e)) return { ok: false, error: `Correo no válido: "${e}"` };
      const enabled = input?.enabled === true;
      if (enabled && !emails.length) return { ok: false, error: 'Añade al menos un correo para activar el aviso' };
      let hour = parseInt(input?.hour, 10);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) hour = 9;
      return { ok: true, settings: {
              enabled, emails, hour,
              includeOverdue: input?.includeOverdue === true,
              weekdaysOnly:   input?.weekdaysOnly !== false,
      } };
}

async function saveSettings(pool, username, s) {
      if (!pool) return s;
      await ensureTables(pool);
      await pool.query(
              `INSERT INTO notification_settings (username, enabled, emails, include_overdue, hour, weekdays_only, updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,NOW())
               ON CONFLICT (username) DO UPDATE SET
                 enabled=$2, emails=$3, include_overdue=$4, hour=$5, weekdays_only=$6, updated_at=NOW()`,
              [username, s.enabled, s.emails.join(','), s.includeOverdue, s.hour, s.weekdaysOnly]
      );
      return s;
}

async function listEnabled(pool) {
      if (!pool) return [];
      await ensureTables(pool);
      const { rows } = await pool.query(
              `SELECT * FROM notification_settings WHERE enabled = true AND emails <> ''`);
      return rows.map(r => ({ username: r.username, ...rowToSettings(r) }));
}

// ── Recopilar seguimientos ───────────────────────────────────────────────────
// Devuelve los leads pendientes de UN cliente. includeOverdue decide si además
// de los de hoy se traen los que se quedaron atrás.
async function collectForClient(deps, username, includeOverdue) {
      const { pool, getPipelineStages } = deps;
      const today = todayIn(TZ);
      const empty = { today, todayLeads: [], overdueLeads: [], totalToday: 0, totalOverdue: 0 };
      if (!pool) return empty;

      const { rows } = await pool.query(
              `SELECT data FROM leads
                WHERE username = $1
                  AND COALESCE(data->>'followUpDate','') <> ''
                  AND data->>'followUpDate' <= $2`,
              [username, today]
      );
      if (!rows.length) return empty;

      let closed = new Set(['converted', 'lost']);
      try {
              const st = await getPipelineStages(username);
              closed = new Set(st.filter(s => s.isWon || s.isLost).map(s => s.id));
      } catch {}

      const todayLeads = [], overdueLeads = [];
      for (const r of rows) {
              const lead = r.data || {};
              if (closed.has(lead.stage)) continue;
              const due = String(lead.followUpDate).slice(0, 10);
              const item = {
                      name: lead.name || 'Sin nombre',
                      phone: lead.phone || '',
                      email: lead.email || '',
                      campaign: lead.campaign || '',
                      due, lateDays: daysBetween(due, today),
              };
              (due === today ? todayLeads : overdueLeads).push(item);
      }
      todayLeads.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      // Vencidos del más reciente al más antiguo: los de hace 2 días aún se rescatan
      overdueLeads.sort((a, b) => a.lateDays - b.lateDays);

      return {
              today,
              todayLeads,
              overdueLeads: includeOverdue ? overdueLeads : [],
              totalToday: todayLeads.length,
              totalOverdue: overdueLeads.length,   // el total real, aunque no se listen
      };
}

// Resumen global del admin: todos los clientes agrupados.
async function collectFollowUps(deps) {
      const { pool, getUsers } = deps;
      const today = todayIn(TZ);
      if (!pool) return { today, clients: [], totalToday: 0, totalOverdue: 0 };
      const users = (await getUsers()).filter(u => u.role === 'client');
      const clients = [];
      for (const u of users) {
              const d = await collectForClient(deps, u.username, INCLUDE_OVERDUE);
              if (d.totalToday || (INCLUDE_OVERDUE && d.totalOverdue)) {
                      clients.push({ username: u.username, name: u.name, today: d.todayLeads, overdue: d.overdueLeads });
              }
      }
      clients.sort((a, b) => (b.today.length + b.overdue.length) - (a.today.length + a.overdue.length));
      return {
              today, clients,
              totalToday:   clients.reduce((s, c) => s + c.today.length, 0),
              totalOverdue: clients.reduce((s, c) => s + c.overdue.length, 0),
      };
}

// ── Plantillas HTML (marca LAX: blanco/negro + azul #0000ff) ─────────────────
const esc = s => String(s || '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const MAX_TODAY = 40, MAX_OVERDUE = 15;

const shell = (title, inner) => `<!doctype html><html lang="es"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
</head><body style="margin:0;padding:0;background:#f6f7fb;">
  <div style="font-family:Poppins,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;max-width:640px;margin:0 auto;padding:26px 18px;">
    ${inner}
    <div style="text-align:center;margin:26px 0 10px;">
      <a href="${CRM_URL}" style="background:#0000ff;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 26px;border-radius:9px;display:inline-block;">Abrir el CRM</a>
    </div>
  </div>
</body></html>`;

// Fila de lead con acciones directas: el correo ES la herramienta, no sólo un aviso.
function leadRow(l, waTemplate, late) {
      const digits = waDigits(l.phone);
      const msg = encodeURIComponent(String(waTemplate || '').replace(/\{nombre\}/gi, l.name || ''));
      const btn = (href, bg, color, label) =>
              `<a href="${href}" style="background:${bg};color:${color};text-decoration:none;font-size:12px;font-weight:600;padding:6px 12px;border-radius:7px;display:inline-block;margin-left:6px;white-space:nowrap;">${label}</a>`;
      return `
      <tr>
        <td style="padding:11px 12px;border-bottom:1px solid #eef0f4;">
          <div style="font-size:14px;font-weight:600;color:#0b1120;">${esc(l.name)}</div>
          <div style="font-size:12px;color:#6b7280;margin-top:2px;">
            ${l.campaign ? esc(l.campaign) : ''}${l.campaign && late ? ' · ' : ''}${late ? `<span style="color:#b91c1c;font-weight:600;">vencido hace ${l.lateDays} día${l.lateDays === 1 ? '' : 's'}</span>` : ''}
          </div>
        </td>
        <td style="padding:11px 12px;border-bottom:1px solid #eef0f4;text-align:right;white-space:nowrap;">
          ${digits ? btn(`https://wa.me/${digits}?text=${msg}`, '#dcfce7', '#166534', 'WhatsApp') : ''}
          ${l.phone ? btn(`tel:${esc(l.phone)}`, '#e8eaff', '#0000ff', 'Llamar') : ''}
          ${!digits && !l.phone && l.email ? btn(`mailto:${esc(l.email)}`, '#f1f5f9', '#334155', 'Email') : ''}
        </td>
      </tr>`;
}

function leadTable(title, leads, waTemplate, late, cap) {
      if (!leads.length) return '';
      const list = leads.slice(0, cap);
      const rest = leads.length - list.length;
      return `
      <div style="margin:18px 0 6px;font-size:13px;font-weight:700;color:${late ? '#b91c1c' : '#0b1120'};">
        ${title} (${leads.length})
      </div>
      <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #eef0f4;border-radius:10px;">
        ${list.map(l => leadRow(l, waTemplate, late)).join('')}
      </table>
      ${rest > 0 ? `<div style="font-size:12px;color:#6b7280;margin:6px 0 0;">y ${rest} más — verlos en el CRM</div>` : ''}`;
}

// Correo del CLIENTE: sus propios leads, orientado a la acción.
function buildClientEmailHtml(data, opts = {}) {
      const { today, todayLeads, overdueLeads } = data;
      const { waTemplate = '', clientName = '' } = opts;
      const n = todayLeads.length;
      const titular = n
              ? `Tienes ${n} persona${n === 1 ? '' : 's'} a la${n === 1 ? '' : 's'} que contactar hoy`
              : (overdueLeads.length ? 'Tienes seguimientos pendientes' : 'Hoy no toca contactar a nadie');

      const inner = `
    <div style="margin-bottom:18px;">
      <div style="font-size:20px;font-weight:700;color:#0b1120;">${esc(titular)}</div>
      <div style="font-size:13px;color:#6b7280;margin-top:3px;">${fmtEs(today)}${clientName ? ' · ' + esc(clientName) : ''}</div>
    </div>
    ${leadTable('Para hoy', todayLeads, waTemplate, false, MAX_TODAY)}
    ${leadTable('Pendientes de días anteriores', overdueLeads, waTemplate, true, MAX_OVERDUE)}
    ${(!todayLeads.length && !overdueLeads.length)
        ? '<div style="background:#fff;border:1px solid #eef0f4;border-radius:10px;padding:22px;text-align:center;color:#6b7280;font-size:14px;">Nada pendiente por hoy. 🎉</div>' : ''}
    <div style="text-align:center;font-size:11px;color:#9aa3b2;margin-top:22px;">
      Aviso automático de tu CRM · puedes cambiar el correo y el horario desde <strong>Avisos</strong> en el CRM
    </div>`;
      return shell(titular, inner);
}

// Correo del ADMIN: todos los clientes agrupados.
function buildEmailHtml(data) {
      const { today, clients, totalToday, totalOverdue } = data;
      const visibles = INCLUDE_OVERDUE ? clients : clients.filter(c => c.today.length);
      const blocks = visibles.map(c => `
      <div style="margin:0 0 26px;">
        <div style="font-size:16px;font-weight:700;color:#0b1120;padding-bottom:6px;border-bottom:2px solid #0000ff;display:inline-block;">${esc(c.name)}</div>
        ${INCLUDE_OVERDUE ? leadTable('Vencidos — sin contactar', c.overdue, '', true, MAX_OVERDUE) : ''}
        ${leadTable('Para hoy', c.today, '', false, MAX_TODAY)}
      </div>`).join('');

      const inner = `
    <div style="margin-bottom:20px;">
      <div style="font-size:20px;font-weight:700;color:#0b1120;">Seguimientos de hoy</div>
      <div style="font-size:13px;color:#6b7280;margin-top:3px;">${fmtEs(today)} · LAX Group CRM</div>
    </div>
    <div style="display:flex;gap:10px;margin-bottom:22px;">
      <div style="flex:1;max-width:${INCLUDE_OVERDUE ? 'none' : '190px'};background:#fff;border:1px solid #eef0f4;border-radius:10px;padding:14px;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6b7280;font-weight:600;">Para hoy</div>
        <div style="font-size:26px;font-weight:700;color:#0000ff;margin-top:2px;">${totalToday}</div>
      </div>
      ${INCLUDE_OVERDUE ? `<div style="flex:1;background:#fff;border:1px solid #eef0f4;border-radius:10px;padding:14px;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6b7280;font-weight:600;">Vencidos</div>
        <div style="font-size:26px;font-weight:700;color:${totalOverdue ? '#b91c1c' : '#0b1120'};margin-top:2px;">${totalOverdue}</div>
      </div>` : ''}
    </div>
    ${blocks || '<div style="background:#fff;border:1px solid #eef0f4;border-radius:10px;padding:20px;text-align:center;color:#6b7280;font-size:14px;">Hoy no toca contactar a nadie. 🎉</div>'}
    <div style="text-align:center;font-size:11px;color:#9aa3b2;margin-top:14px;">
      Aviso automático de LAX Group CRM · cada día a las ${String(NOTIFY_HOUR).padStart(2, '0')}:00
    </div>`;
      return shell('Seguimientos de hoy', inner);
}

// ── Envíos ───────────────────────────────────────────────────────────────────
async function sendClientDigest(deps, username, settings, { force = false } = {}) {
      const s = settings || await getSettings(deps.pool, username);
      if (!s.emails.length) return { sent: false, reason: 'Sin correo configurado' };

      const data = await collectForClient(deps, username, s.includeOverdue);
      const total = data.todayLeads.length + data.overdueLeads.length;
      if (!total && !force) return { sent: false, reason: 'Nada pendiente', ...data };

      let waTemplate = '', clientName = username;
      try { waTemplate = await deps.getWhatsappTemplate(username); } catch {}
      try {
              const u = (await deps.getUsers()).find(x => x.username === username);
              if (u) clientName = u.name;
      } catch {}

      const n = data.todayLeads.length;
      const subject = n
              ? `📋 ${n} persona${n === 1 ? '' : 's'} a la${n === 1 ? '' : 's'} que contactar hoy`
              : (data.overdueLeads.length ? `📋 ${data.overdueLeads.length} seguimiento${data.overdueLeads.length === 1 ? '' : 's'} pendiente${data.overdueLeads.length === 1 ? '' : 's'}` : '📋 Hoy no toca contactar a nadie');

      await sendViaResend(s.emails, subject, buildClientEmailHtml(data, { waTemplate, clientName }), s.emails[0]);
      return { sent: true, to: s.emails, subject, totalToday: data.todayLeads.length, totalOverdue: data.overdueLeads.length };
}

async function sendDigest(deps, { force = false } = {}) {
      const data = await collectFollowUps(deps);
      const total = INCLUDE_OVERDUE ? data.totalToday + data.totalOverdue : data.totalToday;
      if (!total && !force) return { sent: false, reason: 'Hoy no toca contactar a nadie', ...data };
      const subject = total
              ? `📋 ${data.totalToday} seguimiento${data.totalToday === 1 ? '' : 's'} para hoy` +
                (INCLUDE_OVERDUE && data.totalOverdue ? ` · ${data.totalOverdue} vencido${data.totalOverdue === 1 ? '' : 's'}` : '')
              : '📋 Hoy no toca contactar a nadie';
      await sendViaResend(TO_EMAIL, subject, buildEmailHtml(data));
      return { sent: true, to: TO_EMAIL, subject, ...data };
}

// ── Programador ──────────────────────────────────────────────────────────────
// La marca de "ya enviado hoy" vive en la base de datos, así que aunque Railway
// reinicie el contenedor varias veces cada correo sale UNA sola vez.
async function claim(pool, kind, dateISO) {
      if (!pool) return true;
      await ensureTables(pool);
      const r = await pool.query(
              `INSERT INTO notification_log (kind, sent_date) VALUES ($1,$2)
               ON CONFLICT (kind, sent_date) DO NOTHING`, [kind, dateISO]);
      return r.rowCount > 0;
}

function startScheduler(deps) {
      const { pool } = deps;
      const tick = async () => {
              if (!process.env.RESEND_API_KEY) return;
              const today = todayIn(TZ);
              const hour  = hourIn(TZ);

              // 1) Avisos por cliente (cada uno con su hora y sus ajustes)
              try {
                      for (const s of await listEnabled(pool)) {
                              if (s.hour !== hour) continue;
                              if (s.weekdaysOnly && isWeekend(today)) continue;
                              if (!(await claim(pool, 'followups:' + s.username, today))) continue;
                              try {
                                      const r = await sendClientDigest(deps, s.username, s);
                                      console.log(r.sent
                                              ? `📧 [${s.username}] aviso enviado a ${r.to.join(', ')} (${r.totalToday} hoy, ${r.totalOverdue} vencidos)`
                                              : `📭 [${s.username}] aviso omitido: ${r.reason}`);
                              } catch (e) {
                                      console.error(`⚠️  [${s.username}] aviso falló:`, e.message);
                              }
                      }
              } catch (e) {
                      console.error('⚠️  Avisos por cliente fallaron:', e.message);
              }

              // 2) Resumen global del admin
              try {
                      if (hour !== NOTIFY_HOUR) return;
                      if (!(await claim(pool, 'followups', today))) return;
                      const r = await sendDigest(deps);
                      console.log(r.sent
                              ? `📧 Resumen admin enviado a ${r.to} (${r.totalToday} hoy, ${r.totalOverdue} vencidos)`
                              : `📭 Resumen admin omitido: ${r.reason}`);
              } catch (e) {
                      console.error('⚠️  Resumen admin falló:', e.message);
              }
      };
      setInterval(tick, 5 * 60 * 1000);
      setTimeout(tick, 30 * 1000);
      console.log(`⏰ Avisos activos · resumen admin ${String(NOTIFY_HOUR).padStart(2, '0')}:00 (${TZ}) → ${TO_EMAIL} · avisos por cliente según sus ajustes`);
}

module.exports = {
      startScheduler, sendDigest, sendClientDigest, collectFollowUps, collectForClient,
      buildEmailHtml, buildClientEmailHtml,
      getSettings, saveSettings, validateSettings, listEnabled, ensureTables,
      todayIn, hourIn, isWeekend, waDigits,
      TO_EMAIL, NOTIFY_HOUR, TZ, DEFAULT_SETTINGS,
};
