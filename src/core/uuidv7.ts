// src/core/uuidv7.ts
import crypto from 'node:crypto';

let lastTimestamp = -1;
let seq = 0;

const HEX_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeTimestampMs(timestampMs?: number): number {
  if (typeof timestampMs !== 'number' || !Number.isFinite(timestampMs)) {
    return Date.now();
  }
  return Math.max(0, Math.floor(timestampMs));
}

/**
 * Generates an opaque RFC 9562 compliant UUIDv7.
 * Encodes Unix timestamp in milliseconds in high 48 bits, version 7, variant 2.
 * Strictly avoids encoding any PII.
 */
export function generateUuidV7(timestampMs?: number): string {
  const now = normalizeTimestampMs(timestampMs);

  if (now === lastTimestamp) {
    seq = (seq + 1) & 0x0fff;
  } else {
    lastTimestamp = now;
    seq = crypto.randomInt(0, 0x0fff);
  }

  const timeHex = now.toString(16).padStart(12, '0');
  const timeHigh = timeHex.slice(0, 8);
  const timeMid = timeHex.slice(8, 12);

  const verAndSeq = (0x7000 | (seq & 0x0fff)).toString(16).padStart(4, '0');

  const randA = crypto.randomInt(0, 0x3fff);
  const varAndRand = (0x8000 | (randA & 0x3fff)).toString(16).padStart(4, '0');

  const randB = crypto.randomBytes(6).toString('hex');

  return `${timeHigh}-${timeMid}-${verAndSeq}-${varAndRand}-${randB}`;
}

export function isValidUuidV7(uuid: string): boolean {
  if (typeof uuid !== 'string') return false;
  return HEX_RE.test(uuid.trim());
}

export function isUuidV7Like(value: unknown): value is string {
  return typeof value === 'string' && isValidUuidV7(value);
}

export function generateDeterministicUuidV7(seed: string): string {
  const source = typeof seed === 'string' ? seed.trim() : '';
  if (!source) {
    return generateUuidV7();
  }
  const hash = crypto.createHash('sha256').update(source).digest('hex');
  const timestamp = Number.parseInt(hash.slice(0, 12), 16) % 2 ** 41;
  return generateUuidV7(timestamp * 1000);
}

