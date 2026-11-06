/* First-period-ending notice (ISO-1397 catalog entry, sent by billing's tickFirstPeriodNotices
 * hook in server.js since ISO-1393). `amount` is a pre-formatted string ("R$ 89,00") rather than a
 * number: currency formatting is billing's decision, not this template's. The button opens
 * Settings — it is a plain route, not a one-time token, so the layout does not print the URL as
 * copyable text under it (`fallback: false`). */
import { renderEmail, escapeHtml, trimSlash } from './layout.js';

export function renderPreChargeNotice({ name, amount, billingDate, appUrl }) {
  const subject = 'Sua primeira cobrança cheia é em breve — Brilhart Fitness';
  const text = `Oi, ${name}!

O seu primeiro mês no Brilhart Fitness foi por R$ 1,99. A partir de ${billingDate}, a cobrança
passa a ser o valor normal do seu plano, ${amount}.

Se quiser cancelar ou mudar de plano antes disso, você pode fazer isso a qualquer momento em
Configurações → Assinatura.`;

  const html = renderEmail({
    appUrl,
    preheader: `A partir de ${billingDate}, sua assinatura passa a custar ${amount}. Mude ou cancele quando quiser.`,
    title: 'Sua primeira cobrança cheia é em breve',
    paragraphs: [
      `Oi, ${escapeHtml(name)}!`,
      `O seu primeiro mês no Brilhart Fitness foi por R$ 1,99. A partir de <strong>${escapeHtml(billingDate)}</strong>, a cobrança passa a ser o valor normal do seu plano, <strong>${escapeHtml(amount)}</strong>.`
    ],
    cta: { label: 'Ver minha assinatura', url: `${trimSlash(appUrl)}/#/configuracoes`, fallback: false },
    notice: 'Para cancelar ou mudar de plano antes disso, abra Configurações e vá em Assinatura. Pode fazer a qualquer momento.',
    footerNote: 'Você recebe este aviso porque assinou o Brilhart Fitness com este e-mail.'
  });
  return { subject, text, html };
}
