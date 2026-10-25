/* Confirmation e-mail, sent after a signup and on every resend (ISO-1397). `text` is the whole
 * message on its own — it is what the `log` mail driver prints and what a text-only client shows;
 * `html` is the same message in the brand layout (layout.js), with the link as a button and, under
 * it, as copyable text for whoever reads this on one device and signs in on another. */
import { renderEmail, escapeHtml } from './layout.js';

export function renderVerifyEmail({ name, link, appUrl }) {
  const subject = 'Confirme seu e-mail — Brilhart Fitness';
  const text = `Oi, ${name}!

Confirme seu e-mail para continuar usando o Brilhart Fitness:

${link}

Este link vale por 24 horas e funciona uma única vez. Se você não pediu isso, ignore este e-mail.`;

  const html = renderEmail({
    appUrl,
    preheader: 'Falta só um passo: confirme que este endereço é seu. O link vale por 24 horas.',
    title: 'Confirme seu e-mail',
    paragraphs: [
      `Oi, ${escapeHtml(name)}!`,
      'Falta só um passo: confirme que este endereço é seu para continuar usando o Brilhart Fitness.'
    ],
    cta: { label: 'Confirmar e-mail', url: link },
    notice: 'Este link vale por 24 horas e funciona uma única vez.',
    footerNote: 'Se você não pediu esta confirmação, ignore este e-mail. Nada muda na sua conta.'
  });
  return { subject, text, html };
}
