#!/usr/bin/env node
/* Renders the three transactional e-mails (api/mail-templates/) to HTML files, so the layout can
 * be opened in a browser — or screenshotted at phone width — without a mail server in the loop.
 *
 *   node scripts/mail-preview.mjs [outDir] [appUrl]
 *
 * outDir defaults to ./mail-preview (gitignored output, next to this script's package); appUrl
 * defaults to APP_URL, then https://fit.brilhart.com.br. Pass a file:// URL that points at
 * frontend/public to preview the logo before the app is deployed with it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderVerifyEmail } from '../mail-templates/verify-email.js';
import { renderRecoverEmail } from '../mail-templates/recover-access.js';
import { renderPreChargeNotice } from '../mail-templates/pre-charge-notice.js';

const outDir = resolve(process.argv[2] || 'mail-preview');
const appUrl = process.argv[3] || process.env.APP_URL || 'https://fit.brilhart.com.br';
const token = 'c2FtcGxlLXRva2VuLW5vdC1yZWFs.9f1c2b7e4a';

const samples = {
  'verify-email': renderVerifyEmail({ name: 'Ana', link: `${appUrl}/#/verificar-email?token=${encodeURIComponent(token)}`, appUrl }),
  'recover-access': renderRecoverEmail({ name: 'Ana', link: `${appUrl}/#/recuperar?token=${encodeURIComponent(token)}`, appUrl }),
  'pre-charge-notice': renderPreChargeNotice({ name: 'Ana', amount: 'R$ 89,00', billingDate: '12/11/2026', appUrl })
};

mkdirSync(outDir, { recursive: true });
for (const [name, { subject, text, html }] of Object.entries(samples)) {
  writeFileSync(resolve(outDir, `${name}.html`), html);
  writeFileSync(resolve(outDir, `${name}.txt`), `Subject: ${subject}\n\n${text}\n`);
  console.log(`${name}: ${subject}`);
}
console.log(`\nwritten to ${outDir}`);
