// ─────────────────────────────────────────────────────────────────────────────
// Aviso diario por correo de los seguimientos que tocan.
//
// Una vez al día (NOTIFY_HOUR, hora de Madrid) recorre TODOS los clientes y
// manda un único resumen al admin con:
//   · los leads cuya fecha de próximo contacto es HOY
//   · los que quedaron VENCIDOS sin contactar
// Se excluyen los leads en columnas de "convertido"/"perdido" de cada cliente.
//
// No añade dependencias: usa el https nativo contra la API de Resend, igual
// que el dashboard de anuncios.
// ─────────────────────────────────────────────────────────────────────────────
const https = require('https');

const TZ          = process.env.NOTIFY_TZ    || 'Europe/Madrid';
const NOTIFY_HOUR = parseInt(process.env.NOTIFY_HOUR || '11', 10);
const TO_EMAIL    = process.env.NOTIFY_EMAIL || 'yo@arturoabellan.com';
const FROM_EMAIL  = process.env.RESEND_FROM  || 'LAX Group CRM <onboarding@resend.dev>';
const CRM_URL     = process.env.CRM_URL      || 'https://laxcrm.up.railway.app';

// ── Fecha de hoy en la zona horaria del negocio (el servidor va en UTC) ──
function todayIn(tz) {
      // en-CA da directamente YYYY-MM-DD
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function hourIn(tz) {
      return parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date()), 10);
}
const fmtEs = iso => { const [y, m, d] = String(iso).split('-'); return `${d}/${m}/${y}`; };
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

// ── Envío vía Resend ──────────────────────────────────────────────────────────
function sendViaResend(to, subject, html) {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) return Promise.reject(new Error('RESEND_API_KEY no configurada'));
      // reply_to: el remitente es un buzón técnico al que no se accede, así que
      // cualquier respuesta debe volver a la dirección real del destinatario.
      const body = JSON.stringify({
              from: FROM_EMAIL,
              to: Array.isArray(to) ? to : [to],
              reply_to: TO_EMAIL,
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

// ── Recopilar los seguimientos pendientes de todos los clientes ───────────────
// deps = { pool, getUsers, getPipelineStages }
async function collectFollowUps(deps) {
      const { pool, getUsers, getPipelineStages } = deps;
      const today = todayIn(TZ);
      if (!pool) return { today, clients: [], totalToday: 0, totalOverdue: 0 };

      const { rows } = await pool.query(
              `SELECT username, data FROM leads
                WHERE COALESCE(data->>'followUpDate','') <> ''
                  AND data->>'followUpDate' <= $1`,
              [today]
      );

      const users   = await getUsers();
      const byUser  = new Map();
      const nameOf  = u => { const f = users.find(x => x.username === u); return f ? f.name : u; };

      // Columnas cerradas (ganada/perdida) por cliente: esos leads no se avisan
      const closedCache = {};
      const closedFor = async username => {
              if (!closedCache[username]) {
                      try {
                              const st = await getPipelineStages(username);
                              closedCache[username] = new Set(st.filter(s => s.isWon || s.isLost).map(s => s.id));
                      } catch { closedCache[username] = new Set(['converted', 'lost']); }
              }
              return closedCache[username];
      };

      for (const r of rows) {
              const lead = r.data || {};
              const closed = await closedFor(r.username);
              if (closed.has(lead.stage)) continue;
              const due = String(lead.followUpDate).slice(0, 10);
              if (!byUser.has(r.username)) byUser.set(r.username, { username: r.username, name: nameOf(r.username), today: [], overdue: [] });
              const bucket = byUser.get(r.username);
              (due === today ? bucket.today : bucket.overdue).push({
                      name: lead.name || 'Sin nombre',
                      phone: lead.phone || '',
                      email: lead.email || '',
                      campaign: lead.campaign || '',
                      due,
                      lateDays: daysBetween(due, today),
              });
      }

      const clients = [...byUser.values()]
              .map(c => ({ ...c, overdue: c.overdue.sort((a, b) => b.lateDays - a.lateDays) }))
              .filter(c => c.today.length || c.overdue.length)
              .sort((a, b) => (b.today.length + b.overdue.length) - (a.today.length + a.overdue.length));

      return {
              today,
              clients,
              totalToday:   clients.reduce((s, c) => s + c.today.length, 0),
              totalOverdue: clients.reduce((s, c) => s + c.overdue.length, 0),
      };
}

// ── Plantilla HTML (marca LAX: blanco/negro + azul #0000ff de acento) ─────────
const esc = s => String(s || '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

function buildEmailHtml(data) {
      const { today, clients, totalToday, totalOverdue } = data;
      const row = (l, late) => `
        <tr>
          <td style="padding:9px 10px;border-bottom:1px solid #eef0f4;font-size:14px;color:#0b1120;font-weight:600;">
            ${esc(l.name)}
            ${l.campaign ? `<div style="font-weight:400;color:#6b7280;font-size:12px;margin-top:2px;">${esc(l.campaign)}</div>` : ''}
          </td>
          <td style="padding:9px 10px;border-bottom:1px solid #eef0f4;font-size:13px;color:#374151;white-space:nowrap;">
            ${l.phone ? `<a href="tel:${esc(l.phone)}" style="color:#0000ff;text-decoration:none;">${esc(l.phone)}</a>` : '—'}
          </td>
          <td style="padding:9px 10px;border-bottom:1px solid #eef0f4;font-size:13px;white-space:nowrap;color:${late ? '#b91c1c' : '#374151'};font-weight:${late ? '600' : '400'};">
            ${late ? `⚠ ${fmtEs(l.due)} · ${l.lateDays} día${l.lateDays === 1 ? '' : 's'}` : 'Hoy'}
          </td>
        </tr>`;

      const block = (title, leads, late) => !leads.length ? '' : `
        <div style="margin:14px 0 4px;font-size:13px;font-weight:700;color:${late ? '#b91c1c' : '#0b1120'};">
          ${title} (${leads.length})
        </div>
        <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #eef0f4;border-radius:8px;">
          ${leads.map(l => row(l, late)).join('')}
        </table>`;

      const clientBlocks = clients.map(c => `
        <div style="margin:0 0 26px;">
          <div style="font-size:16px;font-weight:700;color:#0b1120;padding-bottom:6px;border-bottom:2px solid #0000ff;display:inline-block;">
            ${esc(c.name)}
          </div>
          ${block('Vencidos — sin contactar', c.overdue, true)}
          ${block('Para hoy', c.today, false)}
        </div>`).join('');

      // El charset es obligatorio: sin él los acentos y la ñ llegan rotos
      // ("GinÃ©s" en vez de "Ginés") en muchos clientes de correo.
      return `<!doctype html><html lang="es"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Seguimientos de hoy</title>
</head><body style="margin:0;padding:0;background:#f6f7fb;">
  <div style="font-family:Poppins,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;max-width:640px;margin:0 auto;padding:26px 18px;">

    <div style="margin-bottom:20px;">
      <div style="font-size:20px;font-weight:700;color:#0b1120;">Seguimientos de hoy</div>
      <div style="font-size:13px;color:#6b7280;margin-top:3px;">${fmtEs(today)} · LAX Group CRM</div>
    </div>

    <div style="display:flex;gap:10px;margin-bottom:22px;">
      <div style="flex:1;background:#fff;border:1px solid #eef0f4;border-radius:10px;padding:14px;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6b7280;font-weight:600;">Para hoy</div>
        <div style="font-size:26px;font-weight:700;color:#0000ff;margin-top:2px;">${totalToday}</div>
      </div>
      <div style="flex:1;background:#fff;border:1px solid #eef0f4;border-radius:10px;padding:14px;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6b7280;font-weight:600;">Vencidos</div>
        <div style="font-size:26px;font-weight:700;color:${totalOverdue ? '#b91c1c' : '#0b1120'};margin-top:2px;">${totalOverdue}</div>
      </div>
    </div>

    ${clientBlocks || '<div style="background:#fff;border:1px solid #eef0f4;border-radius:10px;padding:20px;text-align:center;color:#6b7280;font-size:14px;">No hay seguimientos pendientes. 🎉</div>'}

    <div style="text-align:center;margin:26px 0 10px;">
      <a href="${CRM_URL}" style="background:#0000ff;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 26px;border-radius:9px;display:inline-block;">
        Abrir el CRM
      </a>
    </div>
    <div style="text-align:center;font-size:11px;color:#9aa3b2;margin-top:14px;">
      Aviso automático de LAX Group CRM · se envía cada día a las ${String(NOTIFY_HOUR).padStart(2, '0')}:00
    </div>
  </div>
</body></html>`;
}

// ── Envío del resumen ─────────────────────────────────────────────────────────
// force=true → envía aunque no haya nada pendiente (para la prueba manual)
async function sendDigest(deps, { force = false } = {}) {
      const data = await collectFollowUps(deps);
      const total = data.totalToday + data.totalOverdue;
      if (!total && !force) return { sent: false, reason: 'Sin seguimientos pendientes', ...data };

      const subject = total
              ? `📋 ${data.totalToday} seguimiento${data.totalToday === 1 ? '' : 's'} para hoy` +
                (data.totalOverdue ? ` · ${data.totalOverdue} vencido${data.totalOverdue === 1 ? '' : 's'}` : '')
              : '📋 Sin seguimientos pendientes hoy';

      await sendViaResend(TO_EMAIL, subject, buildEmailHtml(data));
      return { sent: true, to: TO_EMAIL, subject, ...data };
}

// ── Programador: una vez al día, a prueba de reinicios ────────────────────────
// La marca de "ya enviado hoy" vive en la base de datos, así que aunque Railway
// reinicie el contenedor varias veces el correo sale UNA sola vez.
async function claimToday(pool, dateISO) {
      if (!pool) return true;
      await pool.query(`CREATE TABLE IF NOT EXISTS notification_log (
              kind TEXT NOT NULL, sent_date DATE NOT NULL, sent_at TIMESTAMPTZ DEFAULT NOW(),
              PRIMARY KEY (kind, sent_date))`);
      const r = await pool.query(
              `INSERT INTO notification_log (kind, sent_date) VALUES ('followups', $1)
               ON CONFLICT (kind, sent_date) DO NOTHING`, [dateISO]);
      return r.rowCount > 0;   // 0 = ya se envió hoy
}

function startScheduler(deps) {
      const { pool } = deps;
      const tick = async () => {
              try {
                      if (hourIn(TZ) !== NOTIFY_HOUR) return;
                      if (!process.env.RESEND_API_KEY) return;   // sin clave no hay nada que hacer
                      const today = todayIn(TZ);
                      if (!(await claimToday(pool, today))) return;
                      const r = await sendDigest(deps);
                      console.log(r.sent
                              ? `📧 Aviso de seguimientos enviado a ${r.to} (${r.totalToday} hoy, ${r.totalOverdue} vencidos)`
                              : `📭 Aviso de seguimientos omitido: ${r.reason}`);
              } catch (e) {
                      console.error('⚠️  Aviso de seguimientos falló:', e.message);
              }
      };
      setInterval(tick, 5 * 60 * 1000);   // cada 5 min; la marca en BD evita duplicados
      setTimeout(tick, 30 * 1000);        // y una comprobación poco después de arrancar
      console.log(`⏰ Aviso de seguimientos programado a las ${String(NOTIFY_HOUR).padStart(2, '0')}:00 (${TZ}) → ${TO_EMAIL}`);
}

module.exports = { startScheduler, sendDigest, collectFollowUps, buildEmailHtml, todayIn, TO_EMAIL, NOTIFY_HOUR, TZ };
