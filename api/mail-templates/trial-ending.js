/* Warning e-mail before the first full-price charge (ISO-1393) — sent from the subscription's own
 * `customer.subscription.trial_will_end` webhook (3 days out), never from Stripe's built-in trial
 * e-mails: those don't go out in the sandbox, and the issue asks not to depend on them. Plain text
 * only, same as verify-email.js; Atena's HTML replaces `html` later. */
export function renderTrialEndingEmail({ name, planLabel, chargeDate }) {
  const subject = 'Sua cobrança cheia começa em breve — Brilhart Fitness';
  const text = `Oi, ${name}!

O primeiro mês por R$ 1,99 está terminando. A partir de ${chargeDate}, sua assinatura (${planLabel}) passa a cobrar o valor cheio do plano escolhido.

Se quiser trocar de plano ou cancelar, use "Gerenciar assinatura" em Configurações — o cancelamento vale até o fim do período já pago, sem cobrança extra.`;
  return { subject, text, html: `<p>${text.replace(/\n/g, '<br>')}</p>` };
}
