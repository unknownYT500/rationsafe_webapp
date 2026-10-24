// src/core/uuidv7.ts
import crypto from 'node:crypto';

let lastTimestamp = -1;
let seq = 0;

/**
 * Generates an opaque RFC 9562 compliant UUIDv7.
 * Encodes Unix timestamp in milliseconds in high 48 bits, version 7, variant 2.
 * Strictly avoids encoding any PII.
 */
export function generateUuidV7(timestampMs?: number): string {
  const now = timestampMs ?? Date.now();

  if (now === lastTimestamp) {
    seq = (seq + 1) & 0x0fff;
  } else {
    lastTimestamp = now;
    seq = crypto.randomInt(0, 0x0fff);
  }

  // 48-bit timestamp
  const timeHex = now.toString(16).padStart(12, '0');
  const timeHigh = timeHex.slice(0, 8);
  const timeMid = timeHex.slice(8, 12);

  // version 7 (4 bits: 0111) + 12-bit sequence
  const verAndSeq = (0x7000 | (seq & 0x0fff)).toString(16).padStart(4, '0');

  // variant (2 bits: 10) + 14-bit random
  const randA = crypto.randomInt(0, 0x3fff);
  const varAndRand = (0x8000 | (randA & 0x3fff)).toString(16).padStart(4, '0');

  // 48-bit random
  const randB = crypto.randomBytes(6).toString('hex');

  return `${timeHigh}-${timeMid}-${verAndSeq}-${varAndRand}-${randB}`;
}

export function isValidUuidV7(uuid: string): boolean {
  const regex = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return regex.test(uuid);
}
