/* ISO-1415: the `smtp` driver in mail.js, exercised against a tiny in-process fake SMTP server
   (node:net) that stands in for Lyra's shared Mailpit test instance — same protocol, no real
   network. mail.js reads SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/MAIL_PROVIDER as module-level
   consts at import time, so each case here sets env vars and then does a cache-busting dynamic
   import; `node --test` runs every file in its own process, so this cannot leak into another
   test file's module instance. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';

// A server that speaks just enough SMTP to drive the client through a full send: greets, accepts
// EHLO/AUTH/MAIL/RCPT/DATA, and records every line it receives (including the message body) for
// the test to assert on. `script` lets a case override a reply code to exercise failure paths.
function fakeSmtpServer(script = {}) {
  const received = [];
  let dataMode = false;
  let dataBuf = '';
  const server = createServer(socket => {
    socket.write('220 fake.smtp greeting\r\n');
    socket.on('data', chunk => {
      const text = chunk.toString('utf8');
      if (dataMode) {
        dataBuf += text;
        if (dataBuf.endsWith('\r\n.\r\n')) {
          dataMode = false;
          received.push({ cmd: 'DATA-BODY', body: dataBuf.slice(0, -5) });
          socket.write(`${script.data || '250 ok queued'}\r\n`);
        }
        return;
      }
      for (const line of text.split('\r\n').filter(Boolean)) {
        received.push({ cmd: line });
        const verb = line.split(' ')[0];
        if (verb === 'EHLO') socket.write(`${script.ehlo || '250 fake.smtp'}\r\n`);
        else if (verb === 'AUTH') socket.write(`${script.auth || '235 ok'}\r\n`);
        else if (verb === 'MAIL') socket.write(`${script.mail || '250 ok'}\r\n`);
        else if (verb === 'RCPT') socket.write(`${script.rcpt || '250 ok'}\r\n`);
        else if (verb === 'DATA') { socket.write(`${script.dataStart || '354 go ahead'}\r\n`); dataMode = true; }
        else if (verb === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
      }
    });
  });
  return { server, received };
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function withMailModule(env, run) {
  const prevEnv = { ...process.env };
  Object.assign(process.env, { MAIL_PROVIDER: 'smtp', MAIL_FROM: 'Brilhart Fitness <no-reply@brilhart.test>', ...env });
  try {
    const { sendMail } = await import(`../mail.js?t=${Date.now()}-${Math.random()}`);
    await run(sendMail);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in prevEnv)) delete process.env[k];
    Object.assign(process.env, prevEnv);
  }
}

test('smtp driver sends a full RFC 5321 transaction to the configured host', async () => {
  const { server, received } = fakeSmtpServer();
  const port = await listen(server);
  try {
    await withMailModule({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port) }, async sendMail => {
      await sendMail({ to: 'person@example.com', subject: 'Confirm your e-mail', text: 'Click the link.' });
    });
    const cmds = received.map(r => r.cmd).filter(Boolean);
    assert.ok(cmds.some(c => c === 'EHLO brilhart-fitness'));
    assert.ok(cmds.some(c => c === 'MAIL FROM:<no-reply@brilhart.test>'));
    assert.ok(cmds.some(c => c === 'RCPT TO:<person@example.com>'));
    assert.ok(cmds.some(c => c === 'DATA'));
    assert.ok(cmds.some(c => c === 'QUIT'));
    assert.ok(!cmds.some(c => c?.startsWith('AUTH')), 'no SMTP_USER set — no AUTH attempted');
    const body = received.find(r => r.cmd === 'DATA-BODY').body;
    assert.match(body, /Subject: Confirm your e-mail/, 'an ASCII subject goes out as typed');
    assert.match(body, /Message-ID: <[^>]+@brilhart\.test>/);
    assert.match(body, /Content-Type: text\/plain; charset=utf-8/);
    assert.match(body, /Content-Transfer-Encoding: base64/);
    assert.equal(decodeParts(body).length, 1, 'text only: a single part, no multipart wrapper');
    assert.equal(decodeParts(body)[0].content, 'Click the link.');
  } finally { server.close(); }
});

// Reads the base64 bodies back out of what the fake server received: one part for a single-part
// message, one per MIME part for a multipart one.
function decodeParts(body) {
  const [head, ...rest] = body.split('\r\n\r\n');
  const boundary = head.match(/boundary="([^"]+)"/)?.[1];
  if (!boundary) return [{ type: head.match(/Content-Type: ([^;]+)/)[1], content: Buffer.from(rest.join(''), 'base64').toString('utf8') }];
  return body.split(`--${boundary}`).slice(1, -1).map(part => {
    const [partHead, ...partBody] = part.trim().split('\r\n\r\n');
    return { type: partHead.match(/Content-Type: ([^;]+)/)[1], content: Buffer.from(partBody.join(''), 'base64').toString('utf8') };
  });
}

test('text + html go out together as multipart/alternative, UTF-8 intact, subject as an RFC 2047 word', async () => {
  const { server, received } = fakeSmtpServer();
  const port = await listen(server);
  try {
    await withMailModule({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port) }, async sendMail => {
      await sendMail({
        to: 'person@example.com', subject: 'Confirme seu e-mail — Brilhart Fitness',
        text: 'Oi, Zé!\n\nConfirme: https://x.test/#/v?t=1',
        html: '<!DOCTYPE html><html><body><p>Oi, Zé!</p><a href="https://x.test/#/v?t=1">Confirmar</a>' + '<i>'.repeat(600) + '</body></html>'
      });
    });
    const body = received.find(r => r.cmd === 'DATA-BODY').body;
    assert.match(body, /Content-Type: multipart\/alternative; boundary="[^"]+"/);
    assert.match(body, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/m, 'a non-ASCII subject is an encoded word');
    const subjectWord = body.match(/^Subject: =\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/m)[1];
    assert.equal(Buffer.from(subjectWord, 'base64').toString('utf8'), 'Confirme seu e-mail — Brilhart Fitness');
    const parts = decodeParts(body);
    assert.deepEqual(parts.map(p => p.type), ['text/plain', 'text/html'], 'plain first, html last (richest wins)');
    assert.equal(parts[0].content, 'Oi, Zé!\n\nConfirme: https://x.test/#/v?t=1');
    assert.ok(parts[1].content.startsWith('<!DOCTYPE html>'));
    assert.ok(parts[1].content.includes('Oi, Zé!'));
    // RFC 5321: no line of the wire body may exceed 998 characters — the HTML's long lines are wrapped by base64
    for (const line of body.split('\r\n')) assert.ok(line.length <= 998, `line too long: ${line.length}`);
  } finally { server.close(); }
});

test('smtp driver authenticates with AUTH PLAIN when SMTP_USER/SMTP_PASS are set, and never logs the password in cleartext on the wire label', async () => {
  const { server, received } = fakeSmtpServer();
  const port = await listen(server);
  try {
    await withMailModule({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_USER: 'lyra', SMTP_PASS: 'super-secret' }, async sendMail => {
      await sendMail({ to: 'person@example.com', subject: 'Hi', text: 'Body' });
    });
    const authLine = received.map(r => r.cmd).find(c => c?.startsWith('AUTH PLAIN '));
    assert.ok(authLine, 'AUTH PLAIN was sent');
    const decoded = Buffer.from(authLine.slice('AUTH PLAIN '.length), 'base64').toString('utf8');
    assert.equal(decoded, '\0lyra\0super-secret');
  } finally { server.close(); }
});

test('a rejected RCPT TO rejects sendMail with a message that does not leak SMTP_PASS', async () => {
  const { server } = fakeSmtpServer({ rcpt: '550 no such mailbox' });
  const port = await listen(server);
  try {
    await withMailModule({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_USER: 'lyra', SMTP_PASS: 'super-secret' }, async sendMail => {
      await assert.rejects(
        () => sendMail({ to: 'nobody@example.com', subject: 'Hi', text: 'Body' }),
        e => {
          assert.match(e.message, /RCPT failed: 550/);
          assert.ok(!e.message.includes('super-secret'));
          return true;
        }
      );
    });
  } finally { server.close(); }
});

test('MAIL_PROVIDER=smtp with no SMTP_HOST rejects instead of silently writing to the log', async () => {
  await withMailModule({ SMTP_HOST: '' }, async sendMail => {
    await assert.rejects(
      () => sendMail({ to: 'person@example.com', subject: 'Hi', text: 'Body' }),
      /SMTP_HOST is not set/
    );
  });
});
