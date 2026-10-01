/* Transactional e-mail (ISO-1397): sendMail({ to, subject, text, html }) delivers through
 * whichever driver MAIL_PROVIDER names, or writes to the API's own log instead — the default on
 * every self-hosted instance until its owner configures one, and on every test run.
 *
 * The provider itself is deliberately not picked in code (ISO-1386 decision 3 — Anderson already
 * has one and wires it in later, on whichever instance he runs): MAIL_PROVIDER/MAIL_API_KEY/
 * MAIL_FROM alone decide what an instance actually uses. Dependency-light like the rest of api/
 * (CONTRIBUTING.md): a driver here is plain `fetch` against the provider's HTTP API, never a new
 * package — if a real provider turns out to need SMTP instead, that is a dependency and has to be
 * escalated before it is installed, not assumed.
 */
const MAIL_PROVIDER = String(process.env.MAIL_PROVIDER || '').trim().toLowerCase();
const MAIL_API_KEY = process.env.MAIL_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'openGym <no-reply@localhost>';

function validateMessage({ to, subject, text, html }) {
  if (!to || typeof to !== 'string') throw new Error('sendMail: "to" is required');
  if (!subject || typeof subject !== 'string') throw new Error('sendMail: "subject" is required');
  if (!text && !html) throw new Error('sendMail: "text" or "html" is required');
}

// No provider configured: every self-hosted instance until MAIL_API_KEY is set, and every test.
// Full contents, deliberately unmasked — this is standing in for an inbox during development, so
// whoever is testing the flow can read (and click) the link it carries straight off the console.
function logDriver({ to, subject, text, html }) {
  console.log(`mail (log driver) — to: ${to}\nsubject: ${subject}\n${text || html}`);
}

// Real HTTP drivers land here as ISO-1397 learns which provider(s) an instance actually needs
// (see the question on that issue) — each one just a fetch() against its API, keyed by the exact
// string an operator puts in MAIL_PROVIDER.
const DRIVERS = { log: logDriver };

export async function sendMail(message) {
  validateMessage(message);
  if (MAIL_API_KEY && MAIL_PROVIDER && MAIL_PROVIDER !== 'log') {
    const driver = DRIVERS[MAIL_PROVIDER];
    if (driver) return driver(message, { apiKey: MAIL_API_KEY, from: MAIL_FROM });
    console.warn(`mail: MAIL_PROVIDER "${MAIL_PROVIDER}" has no driver yet (ISO-1397) — writing to the log instead`);
  }
  return logDriver(message);
}
