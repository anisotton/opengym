/* Catalog entry only (ISO-1397 scope: the model and its render function). Nothing calls this yet
 * — Phase 3 (Stripe billing, decision 1 of ISO-1386) is what sends it, once a subscription and a
 * billing date actually exist to report. `amount` is a pre-formatted string ("R$ 89,00") rather
 * than a number: currency formatting is Phase 3's decision too, not this template's. */
export function renderPreChargeNotice({ name, amount, billingDate }) {
  const subject = 'Sua primeira cobrança cheia é em breve — Brilhart Fitness';
  const text = `Oi, ${name}!

O seu primeiro mês no Brilhart Fitness foi por R$ 1,99. A partir de ${billingDate}, a cobrança
passa a ser o valor normal do seu plano, ${amount}.

Se quiser cancelar ou mudar de plano antes disso, você pode fazer isso a qualquer momento em
Configurações → Assinatura.`;
  return { subject, text, html: `<p>${text.replace(/\n/g, '<br>')}</p>` };
}
