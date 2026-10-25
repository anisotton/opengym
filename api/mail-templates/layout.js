/* The one HTML layout every transactional e-mail is poured into (verify-email.js, recover-access.js,
 * pre-charge-notice.js). It is the Brilhart Fitness brand guide (docs/brilhart-fitness-marca/)
 * translated into what mail clients can actually render: nested tables, inline styles, a hosted
 * PNG logo (no SVG, no data: URIs — Gmail strips both), web fonts behind safe fallbacks (Apple
 * Mail and iOS honour the @import; Gmail falls back to Georgia / the system sans), and a single
 * column that is 560px wide on a desktop and the full width of a phone.
 *
 * Palette, straight from the guide — nothing invented here:
 *   ameixa  #4A284D  header band, title, button           papel      #F7F3F1  page background
 *   texto   #5F5560  body copy                             lilás txt  #75559A  links
 *   lilás suave #EEE6F4  the "this link expires" box      dourado claro #C9A25A  one 3px rule
 * The gold rule under the plum header is the only accent — the barbell over the ballerina — and
 * the guide allows that colour only on plum or as a large element, which is exactly where it sits.
 *
 * `color-scheme: light` is declared on purpose: the guide forbids plum on a dark background, and a
 * client that auto-inverts the page would produce exactly that. Clients that honour the hint keep
 * the e-mail as designed; the ones that ignore it (Gmail's dark mode) still get legible contrast
 * because every colour is set explicitly rather than inherited.
 */

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export const BRAND = {
  ameixa: '#4A284D', papel: '#F7F3F1', branco: '#FFFFFF', texto: '#5F5560',
  lilasTexto: '#75559A', lilasSuave: '#EEE6F4', douradoClaro: '#C9A25A'
};

const SANS = "Nunito, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const SERIF = "'Cormorant Garamond', Georgia, 'Times New Roman', serif";

// The logo lives with the web app's static files (frontend/public/email/, served by nginx at the
// same origin the links in the e-mail open), so the only URL a template needs is APP_URL. 2× the
// 200px it is displayed at, for retina screens. With no appUrl (an older caller) the path is
// relative — it renders nothing in a mail client, but the alt text still names the sender.
export function logoUrl(appUrl) {
  return `${trimSlash(appUrl)}/email/brilhart-fitness-horizontal-negativo.png`;
}
export const trimSlash = u => String(u || '').replace(/\/+$/, '');

function hostOf(appUrl) {
  try { return new URL(appUrl).host; } catch { return ''; }
}

const p = (html, extra = '') =>
  `<p style="margin:0 0 16px;font-family:${SANS};font-size:16px;line-height:1.6;color:${BRAND.texto};${extra}">${html}</p>`;

/**
 * @param {object} o
 * @param {string} [o.appUrl]      public origin of the app — logo, footer link
 * @param {string} o.title         Cormorant headline (already escaped by the caller if user-sourced)
 * @param {string} [o.preheader]   the line a phone shows under the subject; hidden in the body
 * @param {string[]} o.paragraphs  body copy, HTML strings (callers escape anything user-sourced)
 * @param {{label:string,url:string,fallback?:boolean}} [o.cta]
 *                                 the one button; `fallback` (default true) also prints the URL as
 *                                 copyable text under it, for a link that must open on another device
 * @param {string} [o.notice]      the lilac box — expiry, "once only", where to undo
 * @param {string} [o.footerNote]  small print — "if you didn't ask for this, ignore it"
 */
export function renderEmail({ appUrl = '', title, preheader = '', paragraphs = [], cta, notice, footerNote }) {
  const base = trimSlash(appUrl);
  const host = hostOf(base);
  const showFallback = cta && cta.fallback !== false;

  const button = cta ? `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" class="btn-table" style="margin:28px 0 0;">
              <tr>
                <td bgcolor="${BRAND.ameixa}" style="border-radius:12px;mso-padding-alt:16px 28px;">
                  <a class="btn" href="${escapeHtml(cta.url)}" target="_blank" style="display:inline-block;padding:16px 28px;font-family:${SANS};font-size:16px;line-height:20px;font-weight:700;color:${BRAND.branco};text-decoration:none;border-radius:12px;">${escapeHtml(cta.label)}</a>
                </td>
              </tr>
            </table>` : '';

  const noticeBox = notice ? `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:24px 0 0;">
              <tr>
                <td bgcolor="${BRAND.lilasSuave}" style="border-radius:10px;padding:14px 18px;font-family:${SANS};font-size:15px;line-height:1.55;color:${BRAND.ameixa};">${notice}</td>
              </tr>
            </table>` : '';

  const fallback = showFallback ? `
            ${p(`Se o botão não abrir, copie e cole este link no navegador:`, `margin:24px 0 6px;font-size:14px;`)}
            <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.5;word-break:break-all;"><a href="${escapeHtml(cta.url)}" target="_blank" style="color:${BRAND.lilasTexto};text-decoration:underline;">${escapeHtml(cta.url)}</a></p>` : '';

  const footer = `
            ${footerNote ? `<p style="margin:0 0 14px;font-family:${SANS};font-size:13px;line-height:1.55;color:${BRAND.texto};">${footerNote}</p>` : ''}
            <p style="margin:0;font-family:${SANS};font-size:13px;line-height:1.55;color:${BRAND.texto};">
              ${base ? `<a href="${escapeHtml(base)}" target="_blank" style="color:${BRAND.lilasTexto};font-weight:700;text-decoration:none;">Brilhart Fitness</a>` : `<span style="color:${BRAND.lilasTexto};font-weight:700;">Brilhart Fitness</span>`}<br>
              ${host ? `<span>${escapeHtml(host)}</span><br>` : ''}
              <span>O app de condicionamento físico da Brilhart Escola.</span>
            </p>`;

  return `<!DOCTYPE html>
<html lang="pt-BR" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
  <title>${title}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600&family=Nunito:wght@400;700&display=swap');
    :root { color-scheme: light; supported-color-schemes: light; }
    body { margin:0; padding:0; background:${BRAND.papel}; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
    table { border-collapse:collapse; mso-table-lspace:0; mso-table-rspace:0; }
    img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
    a { color:${BRAND.lilasTexto}; }
    @media only screen and (max-width: 600px) {
      .outer { padding:16px 12px 28px !important; }
      .wrap { width:100% !important; }
      .head { padding:22px 24px !important; border-radius:14px 14px 0 0 !important; }
      .body { padding:28px 22px 30px !important; border-radius:0 0 14px 14px !important; }
      .foot { padding:22px 10px 0 !important; }
      .title { font-size:28px !important; }
      .btn-table { width:100% !important; }
      .btn { display:block !important; text-align:center !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.papel};">
  ${preheader ? `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:${BRAND.papel};">${preheader}</div>` : ''}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.papel}" style="background-color:${BRAND.papel};">
    <tr>
      <td align="center" class="outer" style="padding:40px 16px 48px;">
        <table role="presentation" class="wrap" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:560px;">
          <tr>
            <td class="head" bgcolor="${BRAND.ameixa}" style="background-color:${BRAND.ameixa};padding:28px 40px;border-radius:16px 16px 0 0;">
              <img src="${logoUrl(base)}" width="200" height="53" alt="Brilhart Fitness" style="display:block;width:200px;height:53px;border:0;">
            </td>
          </tr>
          <tr>
            <td bgcolor="${BRAND.douradoClaro}" style="background-color:${BRAND.douradoClaro};height:3px;line-height:3px;font-size:3px;">&nbsp;</td>
          </tr>
          <tr>
            <td class="body" bgcolor="${BRAND.branco}" style="background-color:${BRAND.branco};padding:40px 40px 36px;border-radius:0 0 16px 16px;">
              <h1 class="title" style="margin:0 0 20px;font-family:${SERIF};font-size:32px;line-height:1.12;font-weight:600;letter-spacing:-0.01em;color:${BRAND.ameixa};">${title}</h1>
              ${paragraphs.map(x => p(x)).join('\n              ')}${button}${noticeBox}${fallback}
            </td>
          </tr>
          <tr>
            <td class="foot" style="padding:26px 16px 0;">${footer}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;
}
