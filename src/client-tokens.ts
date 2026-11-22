// Client tokens (ADR 0003): every /mcp request must carry one client's bearer
// token. Each token is a Docker secret file named client_token_<client>; only
// its SHA-256 digest and the client name are kept in memory.
import { createHash, timingSafeEqual } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PREFIX = 'client_token_';
const MIN_LENGTH = 32;

export type TokenCheck =
  | { ok: true; client: string }
  | { ok: false; reason: 'missing' | 'scheme' | 'unknown' };

export interface ClientTokens {
  /** Client names, for the startup log. */
  readonly clients: readonly string[];
  /** Checks an Authorization header value. */
  check(authorization: string | undefined): TokenCheck;
}

function digest(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

/**
 * Reads every client_token_* file in `dir`. Throws, naming the file but never
 * its contents, when there is none, when one is empty or shorter than 32
 * characters, or when two hold the same token: the gateway then refuses to start.
 */
export function loadClientTokens(dir: string): ClientTokens {
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => name.startsWith(PREFIX)).sort();
  } catch {
    files = [];
  }
  if (files.length === 0) throw new Error(`no client token files (${PREFIX}*) in ${dir}`);

  const stored: { client: string; digest: Buffer }[] = [];
  for (const file of files) {
    const token = readFileSync(join(dir, file), 'utf8').replace(/\r?\n$/, '');
    if (token === '') throw new Error(`client token file ${file} is empty`);
    if (token.length < MIN_LENGTH) {
      throw new Error(`client token in ${file} is shorter than ${MIN_LENGTH} characters`);
    }
    const hash = digest(token);
    const same = stored.find((entry) => entry.digest.equals(hash));
    if (same) throw new Error(`client token files ${PREFIX}${same.client} and ${file} hold the same token`);
    stored.push({ client: file.slice(PREFIX.length), digest: hash });
  }

  return {
    clients: stored.map((entry) => entry.client),
    check(authorization) {
      if (authorization === undefined || authorization === '') return { ok: false, reason: 'missing' };
      const space = authorization.indexOf(' ');
      const scheme = space === -1 ? authorization : authorization.slice(0, space);
      if (scheme.toLowerCase() !== 'bearer') return { ok: false, reason: 'scheme' };
      const presented = digest(space === -1 ? '' : authorization.slice(space + 1));
      // Compare against every token, without stopping at a match, so timing
      // doesn't tell which client (or whether any) matched early.
      let client: string | undefined;
      for (const entry of stored) {
        if (timingSafeEqual(presented, entry.digest)) client ??= entry.client;
      }
      return client === undefined ? { ok: false, reason: 'unknown' } : { ok: true, client };
    },
  };
}
