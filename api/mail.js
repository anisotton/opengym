/* Transactional e-mail (ISO-1397): sendMail({ to, subject, text, html }) delivers through
 * whichever driver MAIL_PROVIDER names, or writes to the API's own log instead — the default on
 * every self-hosted instance until its owner configures one, and on every test run.
 *
 * The provider itself is deliberately not picked in code (ISO-1386 decision 3 — Anderson already
 * has one and wires it in later, on whichever instance he runs): MAIL_PROVIDER/MAIL_API_KEY/
 * MAIL_FROM/SMTP_* alone decide what an instance actually uses. Dependency-light like the rest of
 * api/ (CONTRIBUTING.md): an HTTP driver here is plain `fetch` against the provider's API, never a
 * new package; the `smtp` driver (ISO-1415 — Lyra's shared Mailpit test server, plaintext SMTP) is
 * a minimal RFC 5321 client over node:net/node:tls, also no new package. A future provider that
 * needs something neither of those covers is a dependency and has to be escalated before it is
 * installed, not assumed.
 */
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { randomUUID } from 'node:crypto';

const MAIL_PROVIDER = String(process.env.MAIL_PROVIDER || '').trim().toLowerCase();
const MAIL_API_KEY = process.env.MAIL_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'openGym <no-reply@localhost>';
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT) || 25;
const SMTP_SECURE = process.env.SMTP_SECURE === '1';   // implicit TLS (port 465 style); Mailpit itself is plaintext
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';

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

/* ---------------------------------------------------------------------------------- smtp driver
   A deliberately small RFC 5321 client: connect, EHLO, optional AUTH PLAIN, MAIL FROM, RCPT TO,
   DATA, QUIT — no STARTTLS upgrade, no pooling, no retry. That is everything Lyra's shared Mailpit
   test server needs (SMTP_HOST=mailpit, its compose container name — mail.lyra itself only proxies
   Mailpit's web UI, not its SMTP port), and it is plain node:net — a provider that genuinely needs
   STARTTLS or connection pooling is a bigger lift than this ticket, for whenever that is the one
   actually in front of it. */
function smtpAddress(header) {
  const m = header.match(/<([^>]+)>/);
  return (m ? m[1] : header).trim();
}

// Reads one SMTP response, multi-line replies included ("250-...\r\n250 done\r\n" ends on the
// line whose 4th character is a space, not a dash).
function readResponse(socket) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = chunk => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\r\n').filter(Boolean);
      if (!lines.length) return;
      const last = lines[lines.length - 1];
      if (last.length < 4 || last[3] === '-') return;
      cleanup();
      resolve({ code: Number(last.slice(0, 3)), text: lines.map(l => l.slice(4)).join('\n') });
    };
    const onError = e => { cleanup(); reject(e); };
    const onClose = () => { cleanup(); reject(new Error('connection closed')); };
    function cleanup() { socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose); }
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

// `line === null` just waits for the next response (the greeting banner, which nothing prompts).
async function command(socket, line, expect) {
  if (line !== null) socket.write(line + '\r\n');
  const { code, text } = await readResponse(socket);
  if (!expect.includes(code)) {
    // Never the AUTH PLAIN line itself — that is SMTP_USER/SMTP_PASS, base64'd but not secret.
    const label = line === null ? 'connect' : line.startsWith('AUTH') ? 'AUTH' : line.split(' ')[0];
    throw new Error(`smtp: ${label} failed: ${code} ${text}`);
  }
  return text;
}

/* The message itself. `text` and `html` travel together as multipart/alternative when both are
   given — a client picks the richest part it can show, so the plain text (what the `log` driver
   prints) is never thrown away just because an HTML part exists. Every part is base64-encoded:
   the bodies are UTF-8 with lines well past 998 characters (inline-styled table markup), and
   base64 makes neither the line limit nor 8BITMIME the relay's problem. A subject with anything
   outside ASCII (every Brilhart subject has an em dash) goes out as an RFC 2047 encoded word. */
function encodedWord(s) {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}
function base64Lines(s) {
  return Buffer.from(s, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n').replace(/\r\n$/, '');
}
function mimePart(type, content) {
  return [`Content-Type: ${type}; charset=utf-8`, 'Content-Transfer-Encoding: base64', '', base64Lines(content)].join('\r\n');
}
export function buildMime({ from, to, subject, text, html }) {
  const domain = smtpAddress(from).split('@')[1] || 'localhost';
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodedWord(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    'MIME-Version: 1.0'
  ];
  if (text && html) {
    const boundary = `=_brilhart_${randomUUID().replace(/-/g, '')}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    return [
      ...headers, '',
      `--${boundary}`, mimePart('text/plain', text),
      `--${boundary}`, mimePart('text/html', html),
      `--${boundary}--`, ''
    ].join('\r\n');
  }
  const type = html ? 'text/html' : 'text/plain';
  return [...headers, `Content-Type: ${type}; charset=utf-8`, 'Content-Transfer-Encoding: base64', '', base64Lines(html || text)].join('\r\n');
}

function smtpDriver({ to, subject, text, html }, { from }) {
  if (!SMTP_HOST) throw new Error('mail: SMTP_HOST is not set');
  return new Promise((resolve, reject) => {
    const socket = (SMTP_SECURE ? tlsConnect : netConnect)({ host: SMTP_HOST, port: SMTP_PORT });
    const done = (err, value) => { socket.destroy(); err ? reject(err) : resolve(value); };
    socket.once('error', err => done(err));
    socket.once(SMTP_SECURE ? 'secureConnect' : 'connect', async () => {
      try {
        await command(socket, null, [220]);
        await command(socket, 'EHLO brilhart-fitness', [250]);
        if (SMTP_USER) {
          const auth = Buffer.from(`\0${SMTP_USER}\0${SMTP_PASS}`).toString('base64');
          await command(socket, `AUTH PLAIN ${auth}`, [235]);
        }
        await command(socket, `MAIL FROM:<${smtpAddress(from)}>`, [250]);
        await command(socket, `RCPT TO:<${smtpAddress(to)}>`, [250, 251]);
        await command(socket, 'DATA', [354]);
        const body = buildMime({ from, to, subject, text, html }).split('\r\n').map(l => l.startsWith('.') ? '.' + l : l).join('\r\n');
        await command(socket, body + '\r\n.', [250]);
        await command(socket, 'QUIT', [221]).catch(() => {});   // best-effort close, delivery already confirmed
        done(null);
      } catch (e) { done(e); }
    });
  });
}

// Real drivers land here as an instance needs them, each keyed by the exact string an operator
// puts in MAIL_PROVIDER. An HTTP one is just a fetch() against its API; `smtp` above is the first
// (and, for now, only) non-HTTP one.
const DRIVERS = { log: logDriver, smtp: smtpDriver };

export async function sendMail(message) {
  validateMessage(message);
  if (MAIL_PROVIDER && MAIL_PROVIDER !== 'log') {
    const driver = DRIVERS[MAIL_PROVIDER];
    if (driver) return driver(message, { apiKey: MAIL_API_KEY, from: MAIL_FROM });
    console.warn(`mail: MAIL_PROVIDER "${MAIL_PROVIDER}" has no driver yet — writing to the log instead`);
  }
  return logDriver(message);
}
