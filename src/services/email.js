// Email servisi — 3 modda çalışır (env'e göre otomatik seçim):
//   1. SMTP (Nodemailer)  — SMTP_HOST varsa. Natro / kendi mail server için.
//      Env: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE (default true)
//   2. Resend API         — RESEND_API_KEY varsa (SMTP yoksa).
//   3. Mock (log)         — hiçbiri yoksa. Verify link'i console'a düşer.
// EMAIL_FROM her modda kullanılır — default: Abadan <no-reply@abadan.com.tr>

const SMTP_HOST      = process.env.SMTP_HOST || '';
const SMTP_PORT      = parseInt(process.env.SMTP_PORT || '465', 10);
const SMTP_USER      = process.env.SMTP_USER || '';
const SMTP_PASS      = process.env.SMTP_PASS || '';
const SMTP_SECURE    = process.env.SMTP_SECURE !== 'false';  // default true (465 SSL)
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM     = process.env.EMAIL_FROM || 'Abadan <no-reply@abadan.com.tr>';
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// Nodemailer transport'u lazy init — SMTP env yoksa require etme (paket olmayabilir)
let _smtpTransport = null;
function getSmtpTransport() {
  if (_smtpTransport) return _smtpTransport;
  const nodemailer = require('nodemailer');
  _smtpTransport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,   // 465 → true, 587 → false (STARTTLS)
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    // Natro/shared SMTP self-signed cert olabilir — dev'de tolere et
    tls: { rejectUnauthorized: process.env.NODE_ENV === 'production' ? false : false },
  });
  return _smtpTransport;
}

/**
 * Genel email gönderme fonksiyonu.
 * @param {Object} opts
 * @param {string} opts.to - alıcı email
 * @param {string} opts.subject
 * @param {string} opts.html
 * @param {string} [opts.text] - plain text fallback
 * @returns {Promise<{ok: boolean, id?: string, error?: string}>}
 */
async function sendEmail({ to, subject, html, text }) {
  // MOD 1 — SMTP (Nodemailer, Natro/kendi mail server)
  if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
    try {
      const transport = getSmtpTransport();
      const info = await transport.sendMail({
        from: EMAIL_FROM,
        to,
        subject,
        html,
        text: text || undefined,
      });
      console.log(`[email:SMTP] sent to=${to} subject="${subject}" id=${info.messageId}`);
      return { ok: true, id: info.messageId };
    } catch (err) {
      console.error('[email:SMTP] fail:', err.message);
      return { ok: false, error: err.message };
    }
  }

  // MOD 2 — Resend API
  if (RESEND_API_KEY) {
    try {
      const res = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: EMAIL_FROM,
          to: [to],
          subject,
          html,
          text: text || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error('[email:Resend] fail:', res.status, data);
        return { ok: false, error: data.message || `Resend ${res.status}` };
      }
      console.log(`[email:Resend] sent to=${to} subject="${subject}" id=${data.id}`);
      return { ok: true, id: data.id };
    } catch (err) {
      console.error('[email:Resend] send fail:', err.message);
      return { ok: false, error: err.message };
    }
  }

  // MOD 3 — Mock (env yok, dev/test)
  console.log('══════════════════════════════════════════════════════════');
  console.log('[email:MOCK] SMTP_HOST veya RESEND_API_KEY yok — mail gönderilmedi');
  console.log('  To:      ', to);
  console.log('  Subject: ', subject);
  console.log('  ---');
  console.log(text || html.replace(/<[^>]+>/g, ''));
  console.log('══════════════════════════════════════════════════════════');
  return { ok: true, id: 'mock', mock: true };
}

/**
 * Mağaza email doğrulama linki gönderir.
 * @param {string} email
 * @param {string} name
 * @param {string} verifyUrl - tam URL (https://magaza.abadan.com.tr/verify.html?token=xxx)
 */
async function sendStoreVerification(email, name, verifyUrl) {
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8" /></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:30px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.05);">
        <tr>
          <td style="background:#1F4E79;padding:24px;text-align:center;">
            <h1 style="margin:0;color:#fff;font-size:24px;font-weight:800;letter-spacing:2px;">ABADAN</h1>
            <p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:12px;">Mağaza Portalı</p>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 28px;">
            <h2 style="margin:0 0 12px;color:#0f172a;font-size:20px;">Merhaba ${escapeHtml(name)},</h2>
            <p style="margin:0 0 16px;color:#334155;font-size:15px;line-height:22px;">
              Abadan Mağaza portalına kayıt olduğun için teşekkürler.
              Kaydını tamamlamak için aşağıdaki bağlantıya tıklayarak e-posta adresini doğrula:
            </p>
            <p style="margin:24px 0;text-align:center;">
              <a href="${verifyUrl}"
                 style="display:inline-block;background:#1F4E79;color:#fff;text-decoration:none;
                        padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;">
                E-postamı Doğrula
              </a>
            </p>
            <p style="margin:16px 0 0;color:#64748b;font-size:13px;line-height:20px;">
              Buton çalışmıyorsa şu bağlantıyı tarayıcına kopyala:<br />
              <span style="color:#1F4E79;word-break:break-all;">${verifyUrl}</span>
            </p>
            <p style="margin:24px 0 0;padding:14px;background:#fef3c7;border-left:3px solid #f59e0b;color:#78350f;font-size:13px;line-height:20px;">
              <b>Sonraki adım:</b> E-posta doğrulaması sonrası hesabın Abadan ekibi tarafından incelenecek ve
              onay durumu size e-posta ile bildirilecek. Onay süresi genellikle 24 saat içindedir.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;">
            <p style="margin:0;color:#94a3b8;font-size:12px;">
              Bu bağlantı 48 saat geçerlidir. Bu e-postayı siz istemediyseniz görmezden gelebilirsiniz.
            </p>
          </td>
        </tr>
      </table>
      <p style="margin:16px 0 0;color:#94a3b8;font-size:11px;">
        © Abadan · abadan.com.tr
      </p>
    </td></tr>
  </table>
</body>
</html>`;

  const text = `Merhaba ${name},

Abadan Mağaza portalına kayıt olduğun için teşekkürler.
E-posta adresini doğrulamak için aşağıdaki bağlantıya tıkla:

${verifyUrl}

Bu bağlantı 48 saat geçerlidir.

Doğrulama sonrası hesabın Abadan ekibi tarafından incelenecek (24 saat içinde).

—
Abadan
abadan.com.tr`;

  return sendEmail({
    to: email,
    subject: '[Abadan] E-posta adresini doğrula',
    html,
    text,
  });
}

/**
 * Mağaza onay bildirim maili (admin onayladığında).
 */
async function sendStoreApproved(email, name, loginUrl) {
  const html = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8" /></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:30px 0;"><tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;">
      <tr><td style="background:#16a34a;padding:24px;text-align:center;">
        <h1 style="margin:0;color:#fff;font-size:24px;font-weight:800;">✓ Onaylandı</h1>
      </td></tr>
      <tr><td style="padding:32px 28px;">
        <h2 style="margin:0 0 12px;color:#0f172a;font-size:20px;">Merhaba ${escapeHtml(name)},</h2>
        <p style="margin:0 0 16px;color:#334155;font-size:15px;line-height:22px;">
          Abadan Mağaza hesabınız onaylandı. Artık mağaza paneline giriş yapabilirsiniz.
        </p>
        <p style="margin:24px 0;text-align:center;">
          <a href="${loginUrl}" style="display:inline-block;background:#1F4E79;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;">
            Mağaza Girişi
          </a>
        </p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

  return sendEmail({
    to: email,
    subject: '[Abadan] Mağaza hesabınız onaylandı',
    html,
    text: `Merhaba ${name},\n\nAbadan Mağaza hesabınız onaylandı. Giriş: ${loginUrl}\n\n—\nAbadan`,
  });
}

/**
 * Mağaza red bildirim maili.
 */
async function sendStoreRejected(email, name, reason) {
  const html = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8" /></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:30px 0;"><tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;">
      <tr><td style="background:#dc2626;padding:24px;text-align:center;">
        <h1 style="margin:0;color:#fff;font-size:22px;">Başvurunuz Değerlendirildi</h1>
      </td></tr>
      <tr><td style="padding:32px 28px;">
        <p style="margin:0 0 16px;color:#334155;font-size:15px;">Merhaba ${escapeHtml(name)},</p>
        <p style="margin:0 0 16px;color:#334155;font-size:15px;line-height:22px;">
          Abadan Mağaza başvurunuz şu aşamada onaylanmadı.
        </p>
        <p style="margin:16px 0;padding:14px;background:#fee2e2;border-left:3px solid #dc2626;color:#7f1d1d;font-size:13px;">
          <b>Sebep:</b> ${escapeHtml(reason)}
        </p>
        <p style="margin:16px 0 0;color:#64748b;font-size:13px;">
          Sorularınız için: bilgi@abadan.com.tr
        </p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

  return sendEmail({
    to: email,
    subject: '[Abadan] Mağaza başvuru durumu',
    html,
    text: `Merhaba ${name},\n\nAbadan Mağaza başvurunuz onaylanmadı.\nSebep: ${reason}\n\n—\nAbadan`,
  });
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = {
  sendEmail,
  sendStoreVerification,
  sendStoreApproved,
  sendStoreRejected,
};
