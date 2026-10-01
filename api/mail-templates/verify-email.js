/* Confirmation e-mail, sent after a signup and on every resend (ISO-1397). Plain text only —
 * Atena's HTML (ISO-1396, ameixa #4A284D, Cormorant Garamond + Nunito) replaces `html` later;
 * `text` is what the `log` mail driver prints and what a client with no HTML view shows. */
export function renderVerifyEmail({ name, link }) {
  const subject = 'Confirme seu e-mail — Brilhart Fitness';
  const text = `Oi, ${name}!

Confirme seu e-mail para continuar usando o Brilhart Fitness:

${link}

Este link vale por 24 horas e funciona uma única vez. Se você não pediu isso, ignore este e-mail.`;
  return { subject, text, html: `<p>${text.replace(/\n/g, '<br>')}</p>` };
}
