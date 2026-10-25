/* The three transactional e-mails (verify, recover, pre-charge notice) share one branded HTML
   layout (mail-templates/layout.js). What a template owes the caller is checked here, in-process:
   the plain-text part is still the whole message on its own (the `log` driver and text-only
   clients see nothing else), the HTML carries the link both as the button and as copyable text,
   and anything that came from a user (their name) is escaped before it lands in markup. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderVerifyEmail } from '../mail-templates/verify-email.js';
import { renderRecoverEmail } from '../mail-templates/recover-access.js';
import { renderPreChargeNotice } from '../mail-templates/pre-charge-notice.js';
import { renderEmail, escapeHtml, logoUrl } from '../mail-templates/layout.js';

const APP = 'https://fit.brilhart.com.br';
const LINK = `${APP}/#/verificar-email?token=abc%2Fdef&x=1`;

test('escapeHtml neutralises every character that could open markup', () => {
  assert.equal(escapeHtml(`<b>"Ana" & 'Zé'</b>`), '&lt;b&gt;&quot;Ana&quot; &amp; &#39;Zé&#39;&lt;/b&gt;');
  assert.equal(escapeHtml(undefined), '');
});

test('the layout is a complete, mobile-friendly HTML document in the brand palette', () => {
  const html = renderEmail({
    appUrl: APP, preheader: 'Pré-cabeçalho', title: 'Título', paragraphs: ['Um parágrafo.'],
    cta: { label: 'Ir', url: LINK }, notice: 'Vale pouco.', footerNote: 'Rodapé.'
  });
  assert.match(html, /^<!DOCTYPE html>/i);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /lang="pt-BR"/);
  // brand tokens from docs/brilhart-fitness-marca: ameixa, papel, dourado claro, texto
  for (const hex of ['#4A284D', '#F7F3F1', '#C9A25A', '#5F5560']) assert.ok(html.includes(hex), `uses ${hex}`);
  assert.match(html, /Cormorant Garamond/);
  assert.match(html, /Nunito/);
  // the logo is a hosted PNG under the app's own URL (mail clients render neither SVG nor data: URIs)
  assert.ok(html.includes(`src="${logoUrl(APP)}"`));
  assert.ok(logoUrl(APP).endsWith('.png'));
  assert.ok(html.includes('alt="Brilhart Fitness"'));
  // preheader, title, body, CTA, notice, footer all land
  for (const s of ['Pré-cabeçalho', 'Título', 'Um parágrafo.', 'Vale pouco.', 'Rodapé.']) assert.ok(html.includes(s), `renders "${s}"`);
  // the CTA href is the link, attribute-escaped, and the same link is printed as copyable text
  assert.ok(html.includes(`href="${escapeHtml(LINK)}"`));
  assert.ok(html.includes(`>${escapeHtml(LINK)}</a>`), 'raw link printed for copy-paste');
  // never the unescaped ampersand inside an attribute
  assert.ok(!html.includes('token=abc%2Fdef&x=1"'));
});

test('a CTA-less layout (no link to carry) renders no button and no fallback link', () => {
  const html = renderEmail({ appUrl: APP, title: 'T', paragraphs: ['P'] });
  assert.ok(!html.includes('Se o botão não abrir'));
  assert.ok(!/<a [^>]*class="btn"/.test(html));
});

test('verify e-mail: text is self-contained, HTML carries the link as button and as text, name escaped', () => {
  const { subject, text, html } = renderVerifyEmail({ name: '<Ana & Zé>', link: LINK, appUrl: APP });
  assert.equal(subject, 'Confirme seu e-mail — Brilhart Fitness');
  assert.ok(text.includes('Oi, <Ana & Zé>!'), 'plain text keeps the name as typed');
  assert.ok(text.includes(LINK));
  assert.ok(text.includes('24 horas'));
  assert.ok(html.includes('Oi, &lt;Ana &amp; Zé&gt;!'));
  assert.ok(!html.includes('<Ana'), 'name never reaches the markup raw');
  assert.ok(html.includes(`href="${escapeHtml(LINK)}"`));
  assert.ok(html.includes('Confirmar e-mail'));
  assert.ok(html.includes('24 horas'));
});

test('recover e-mail: same contract, 15-minute notice and the "ignore this" line survive in both parts', () => {
  const link = `${APP}/#/recuperar?token=t%3D1`;
  const { subject, text, html } = renderRecoverEmail({ name: 'Ana', link, appUrl: APP });
  assert.equal(subject, 'Recupere seu acesso — Brilhart Fitness');
  assert.ok(text.includes(link));
  assert.ok(text.includes('15 minutos'));
  assert.ok(html.includes(`href="${escapeHtml(link)}"`));
  assert.ok(html.includes('15 minutos'));
  assert.ok(html.includes('ignore este e-mail'));
  assert.ok(html.includes('Criar nova forma de acesso'));
});

test('pre-charge notice: amount and date land in both parts, CTA opens Settings', () => {
  const { subject, text, html } = renderPreChargeNotice({ name: 'Ana', amount: 'R$ 89,00', billingDate: '12/11/2026', appUrl: APP });
  assert.equal(subject, 'Sua primeira cobrança cheia é em breve — Brilhart Fitness');
  for (const part of [text, html]) {
    assert.ok(part.includes('R$ 89,00'));
    assert.ok(part.includes('12/11/2026'));
    assert.ok(part.includes('R$ 1,99'));
  }
  assert.ok(html.includes(`href="${APP}/#/configuracoes"`));
});

test('templates still render without appUrl (older callers): relative logo, no crash', () => {
  const { html } = renderVerifyEmail({ name: 'Ana', link: LINK });
  assert.ok(html.includes('<img'));
  assert.ok(html.includes(LINK.replace(/&/g, '&amp;')));
});
