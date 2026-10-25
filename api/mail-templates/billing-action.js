/* Transactional notices for the admin's own subscription actions (ISO-1619/ISO-1625, T2b, plan §5
 * item 5) — one per action the ficha offers that changes what an account is billed or whether it
 * is billed at all. Every caller is server.js, right after the matching
 * /api/admin/billing/subscription/* route succeeds; nothing here decides whether to send, only
 * how to word it. pt-BR only, same as every other billing surface (billing_plans.display has no
 * other locale yet) — Configurações → Assinatura is where the account can act on any of these.
 */
import { renderEmail, escapeHtml, trimSlash } from './layout.js';

const settingsUrl = appUrl => `${trimSlash(appUrl)}/#/configuracoes`;
const CTA = appUrl => ({ label: 'Ver minha assinatura', url: settingsUrl(appUrl), fallback: false });

export function renderPlanChangeScheduled({ name, planName, amount, effectiveDate, appUrl }) {
  const subject = `Seu plano vai mudar para ${planName} — Brilhart Fitness`;
  const text = `Oi, ${name}!

Sua assinatura do Brilhart Fitness vai mudar para o plano ${planName} a partir de ${effectiveDate}, por ${amount}.
Nada é cobrado agora — a mudança entra em vigor na próxima renovação.

Se isso não foi você, ou quiser cancelar a troca, acesse Configurações → Assinatura.`;
  const html = renderEmail({
    appUrl,
    preheader: `A partir de ${effectiveDate}, sua assinatura passa a ser o plano ${planName}, por ${amount}.`,
    title: 'Seu plano vai mudar',
    paragraphs: [
      `Oi, ${escapeHtml(name)}!`,
      `Sua assinatura vai mudar para o plano <strong>${escapeHtml(planName)}</strong> a partir de <strong>${escapeHtml(effectiveDate)}</strong>, por <strong>${escapeHtml(amount)}</strong>. Nada é cobrado agora — a mudança entra em vigor na próxima renovação.`
    ],
    cta: CTA(appUrl),
    notice: 'Se isso não foi você, ou quiser cancelar a troca, abra Configurações → Assinatura.',
    footerNote: 'Você recebe este aviso porque assina o Brilhart Fitness com este e-mail.'
  });
  return { subject, text, html };
}

export function renderCancelScheduled({ name, effectiveDate, appUrl }) {
  const subject = 'Sua assinatura foi agendada para cancelar — Brilhart Fitness';
  const text = `Oi, ${name}!

Sua assinatura do Brilhart Fitness foi agendada para cancelar em ${effectiveDate}. Você continua com acesso
normal até essa data.

Se isso não foi você, ou quiser manter a assinatura, acesse Configurações → Assinatura.`;
  const html = renderEmail({
    appUrl,
    preheader: `Sua assinatura cancela em ${effectiveDate}. Acesso continua normal até lá.`,
    title: 'Sua assinatura vai cancelar',
    paragraphs: [
      `Oi, ${escapeHtml(name)}!`,
      `Sua assinatura foi agendada para cancelar em <strong>${escapeHtml(effectiveDate)}</strong>. Você continua com acesso normal até essa data.`
    ],
    cta: CTA(appUrl),
    notice: 'Se isso não foi você, ou quiser manter a assinatura, abra Configurações → Assinatura.',
    footerNote: 'Você recebe este aviso porque assina o Brilhart Fitness com este e-mail.'
  });
  return { subject, text, html };
}

export function renderCancelImmediate({ name, appUrl }) {
  const subject = 'Sua assinatura foi cancelada — Brilhart Fitness';
  const text = `Oi, ${name}!

Sua assinatura do Brilhart Fitness foi cancelada agora. O acesso às funções pagas termina imediatamente.

Se isso não foi você, acesse Configurações → Assinatura para assinar de novo.`;
  const html = renderEmail({
    appUrl,
    preheader: 'Sua assinatura foi cancelada e o acesso pago termina agora.',
    title: 'Sua assinatura foi cancelada',
    paragraphs: [
      `Oi, ${escapeHtml(name)}!`,
      'Sua assinatura foi cancelada agora. O acesso às funções pagas termina imediatamente.'
    ],
    cta: CTA(appUrl),
    notice: 'Se isso não foi você, abra Configurações → Assinatura para assinar de novo.',
    footerNote: 'Você recebe este aviso porque assinava o Brilhart Fitness com este e-mail.'
  });
  return { subject, text, html };
}

export function renderCancellationResumed({ name, appUrl }) {
  const subject = 'Seu cancelamento foi desfeito — Brilhart Fitness';
  const text = `Oi, ${name}!

O cancelamento agendado da sua assinatura do Brilhart Fitness foi desfeito. Sua assinatura continua
normalmente, sem interrupção.

Se isso não foi você, acesse Configurações → Assinatura.`;
  const html = renderEmail({
    appUrl,
    preheader: 'Seu cancelamento agendado foi desfeito — sua assinatura continua normalmente.',
    title: 'Seu cancelamento foi desfeito',
    paragraphs: [
      `Oi, ${escapeHtml(name)}!`,
      'O cancelamento agendado da sua assinatura foi desfeito. Ela continua normalmente, sem interrupção.'
    ],
    cta: CTA(appUrl),
    notice: 'Se isso não foi você, abra Configurações → Assinatura.',
    footerNote: 'Você recebe este aviso porque assina o Brilhart Fitness com este e-mail.'
  });
  return { subject, text, html };
}

export function renderCollectionSuspended({ name, resumesAt, appUrl }) {
  const subject = 'Sua cobrança foi suspensa — Brilhart Fitness';
  const resumeLine = resumesAt ? ` A cobrança volta automaticamente em ${resumesAt}.` : '';
  const text = `Oi, ${name}!

A cobrança da sua assinatura do Brilhart Fitness foi suspensa — nenhuma nova fatura será gerada por
enquanto.${resumeLine}

Isso não é um cancelamento. Se tiver dúvidas, acesse Configurações → Assinatura.`;
  const html = renderEmail({
    appUrl,
    preheader: `Sua cobrança foi suspensa.${resumeLine}`,
    title: 'Sua cobrança foi suspensa',
    paragraphs: [
      `Oi, ${escapeHtml(name)}!`,
      `A cobrança da sua assinatura foi suspensa — nenhuma nova fatura será gerada por enquanto.${resumeLine ? ` <strong>${escapeHtml(resumeLine.trim())}</strong>` : ''}`,
      'Isso não é um cancelamento.'
    ],
    cta: CTA(appUrl),
    notice: 'Dúvidas sobre essa suspensão? Abra Configurações → Assinatura.',
    footerNote: 'Você recebe este aviso porque assina o Brilhart Fitness com este e-mail.'
  });
  return { subject, text, html };
}

export function renderCollectionResumed({ name, appUrl }) {
  const subject = 'Sua cobrança foi retomada — Brilhart Fitness';
  const text = `Oi, ${name}!

A cobrança da sua assinatura do Brilhart Fitness foi retomada. As próximas faturas voltam a ser
geradas normalmente.

Se isso não foi você, acesse Configurações → Assinatura.`;
  const html = renderEmail({
    appUrl,
    preheader: 'Sua cobrança foi retomada e volta a gerar faturas normalmente.',
    title: 'Sua cobrança foi retomada',
    paragraphs: [
      `Oi, ${escapeHtml(name)}!`,
      'A cobrança da sua assinatura foi retomada. As próximas faturas voltam a ser geradas normalmente.'
    ],
    cta: CTA(appUrl),
    notice: 'Se isso não foi você, abra Configurações → Assinatura.',
    footerNote: 'Você recebe este aviso porque assina o Brilhart Fitness com este e-mail.'
  });
  return { subject, text, html };
}
