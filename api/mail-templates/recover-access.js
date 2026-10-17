/* "Perdi meu acesso" e-mail (ISO-1397): a single-use, 15-minute link that opens the device-link
 * flow (device-link.js, /api/device-link/options → /verify) to add a fresh passkey on whichever
 * device opens it. `text` stands alone (log driver, text-only clients); `html` is the brand layout
 * (layout.js) — the link is printed as text under the button on purpose, because the whole point
 * of this e-mail is often to carry the link to a *different* device than the one reading it. */
import { renderEmail, escapeHtml } from './layout.js';

export function renderRecoverEmail({ name, link, appUrl }) {
  const subject = 'Recupere seu acesso — Brilhart Fitness';
  const text = `Oi, ${name}!

Alguém (esperamos que você) pediu para recuperar o acesso à sua conta no Brilhart Fitness. Abra
este link no aparelho onde quer entrar, para criar uma nova forma de acesso:

${link}

Este link vale por 15 minutos e funciona uma única vez. Suas formas de acesso antigas continuam
listadas em Configurações, caso queira removê-las depois. Se você não pediu isso, ignore este
e-mail — nada muda na sua conta.`;

  const html = renderEmail({
    appUrl,
    preheader: 'Abra o link no aparelho onde quer entrar e crie uma nova forma de acesso. Vale por 15 minutos.',
    title: 'Recupere seu acesso',
    paragraphs: [
      `Oi, ${escapeHtml(name)}!`,
      'Alguém (esperamos que você) pediu para recuperar o acesso à sua conta no Brilhart Fitness.',
      'Abra o botão abaixo <strong>no aparelho onde quer entrar</strong>. Ele cria uma nova forma de acesso ali mesmo, sem precisar das antigas.'
    ],
    cta: { label: 'Criar nova forma de acesso', url: link },
    notice: 'Este link vale por 15 minutos e funciona uma única vez. Suas formas de acesso antigas continuam listadas em Configurações, caso queira removê-las depois.',
    footerNote: 'Se você não pediu isso, ignore este e-mail. Nada muda na sua conta.'
  });
  return { subject, text, html };
}
