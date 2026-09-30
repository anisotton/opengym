/* The pure shaping rules for a passkey's name (#95) — control characters, folded whitespace,
   invisible format characters. The rows themselves are store.js now (test/store-passkeys.test.js);
   the routes are in server-passkeys.test.js. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { passkeyName } from '../passkeys-store.js';

describe('passkeyName', () => {
  it('folds whitespace and control characters, and caps the length', () => {
    assert.equal(passkeyName('a\u0000b\tc'), 'a b c');
    assert.equal(passkeyName('x'.repeat(100)).length, 40);
    assert.equal(passkeyName(42), '');
    assert.equal(passkeyName({ toString: () => 'x' }), '');
  });

  it('drops invisible format characters that reorder or hide text, and keeps the joiners', () => {
    // Right-to-left override and isolates, zero-width space, word joiner, byte-order mark, soft hyphen.
    assert.equal(passkeyName('Phone\u202Egnp.exe'), 'Phonegnp.exe');
    assert.equal(passkeyName('\u2066Lap\u200Btop\u2069 \u2060\uFEFFkey\u00AD'), 'Laptop key');
    assert.equal(passkeyName('\u200E\u200F\u061C'), '');
    // An emoji sequence and a Devanagari conjunct keep their joiners.
    assert.equal(passkeyName('👨\u200D👩\u200D👧 iPad'), '👨\u200D👩\u200D👧 iPad');
    assert.equal(passkeyName('क्\u200Dष फ़ोन'), 'क्\u200Dष फ़ोन');
  });
});
