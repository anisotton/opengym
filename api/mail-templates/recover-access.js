/* "Perdi meu acesso" e-mail (ISO-1397): a single-use, 15-minute link that opens the device-link
 * flow (device-link.js, /api/device-link/options → /verify) to add a fresh passkey on whichever
 * device opens it. Plain text only — see verify-email.js for why. */
export function renderRecoverEmail({ name, link }) {
  const subject = 'Recupere seu acesso — Brilhart Fitness';
  const text = `Oi, ${name}!

Alguém (esperamos que você) pediu para recuperar o acesso à sua conta no Brilhart Fitness. Abra
este link no aparelho onde quer entrar, para criar uma nova forma de acesso:

${link}

Este link vale por 15 minutos e funciona uma única vez. Suas formas de acesso antigas continuam
listadas em Configurações, caso queira removê-las depois. Se você não pediu isso, ignore este
e-mail — nada muda na sua conta.`;
  return { subject, text, html: `<p>${text.replace(/\n/g, '<br>')}</p>` };
}
