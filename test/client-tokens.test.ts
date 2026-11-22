// Loading and header rules of src/client-tokens.ts, without a running gateway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadClientTokens } from '../src/client-tokens.ts';

const A = 'test-token-a-000000000000000000000000';
const B = 'test-token-b-000000000000000000000000';

function dir(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'client-tokens-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(d, name), content);
  return d;
}

test('names clients after the file prefix and trims one trailing newline', () => {
  const tokens = loadClientTokens(dir({ client_token_a: `${A}\n`, client_token_b: B, other_secret: 'x' }));
  assert.deepEqual(tokens.clients, ['a', 'b']);
  assert.deepEqual(tokens.check(`Bearer ${A}`), { ok: true, client: 'a' });
  assert.deepEqual(tokens.check(`bearer ${B}`), { ok: true, client: 'b' });
  assert.deepEqual(tokens.check(`Bearer ${A}\n`), { ok: false, reason: 'unknown' });
});

test('refuses missing, empty, short and duplicate tokens, naming the file only', () => {
  assert.throws(() => loadClientTokens(dir({})), /no client token files/);
  assert.throws(() => loadClientTokens(join(tmpdir(), 'does-not-exist-client-tokens')), /no client token files/);
  assert.throws(() => loadClientTokens(dir({ client_token_a: '\n' })), /client_token_a is empty/);
  assert.throws(() => loadClientTokens(dir({ client_token_a: 'tiny-secret' })), (error: Error) => {
    assert.match(error.message, /client_token_a is shorter than 32/);
    assert.ok(!error.message.includes('tiny-secret'), 'message leaks the token');
    return true;
  });
  assert.throws(
    () => loadClientTokens(dir({ client_token_a: A, client_token_b: `${A}\n` })),
    /client_token_a and client_token_b hold the same token/,
  );
});

test('gives a reason for each refused header', () => {
  const tokens = loadClientTokens(dir({ client_token_a: A }));
  assert.deepEqual(tokens.check(undefined), { ok: false, reason: 'missing' });
  assert.deepEqual(tokens.check(''), { ok: false, reason: 'missing' });
  assert.deepEqual(tokens.check(`Basic ${A}`), { ok: false, reason: 'scheme' });
  assert.deepEqual(tokens.check(A), { ok: false, reason: 'scheme' });
  assert.deepEqual(tokens.check('Bearer'), { ok: false, reason: 'unknown' });
  assert.deepEqual(tokens.check(`Bearer  ${A}`), { ok: false, reason: 'unknown' });
  assert.deepEqual(tokens.check(`Bearer ${A.slice(0, -1)}`), { ok: false, reason: 'unknown' });
});
