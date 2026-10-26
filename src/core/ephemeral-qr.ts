// src/core/ephemeral-qr.ts
/**
 * Dynamic Ephemeral QR Code Verification & Anti-Replay Engine
 * Enforces a 180-second TTL and monotonic nonces to prevent photo duplication and replay fraud.
 */

import crypto from 'node:crypto';
import type { EphemeralQrPayload, EphemeralQrVerification } from './types.js';

const DEFAULT_SHARED_SECRET = process.env.EPHEMERAL_QR_SECRET || 'rationsafe_ephemeral_qr_pds_secret_2026';
const seenNonces = new Map<string, number>();

function isValidHex(value: unknown, length?: number): value is string {
  return typeof value === 'string' && (!length || value.length === length) && /^[0-9a-f]+$/i.test(value);
}

function isValidPayloadCandidate(value: unknown): value is Partial<EphemeralQrPayload> {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.v === 1 &&
    typeof candidate.cid === 'string' && candidate.cid.trim().length > 0 &&
    typeof candidate.sub === 'string' && candidate.sub.trim().length > 0 &&
    typeof candidate.nonce === 'string' && candidate.nonce.trim().length > 0 &&
    typeof candidate.sig === 'string' && candidate.sig.trim().length > 0
  );
}

/**
 * Builds the canonical string representation for cryptographic hashing.
 */
export function toCanonicalString(payload: Omit<EphemeralQrPayload, 'sig'>): string {
  return `${payload.v}|${payload.cid}|${payload.sub}|${payload.ts}|${payload.exp}|${payload.nonce}`;
}

/**
 * Generates and signs a dynamic ephemeral QR token with a 180-second TTL.
 */
export function generateEphemeralQrToken(
  cardId: string,
  subjectHash: string,
  ttlSeconds = 180,
  secret = DEFAULT_SHARED_SECRET
): EphemeralQrPayload {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + Math.max(30, ttlSeconds);
  const nonce = crypto.randomBytes(16).toString('hex');

  const unsigned: Omit<EphemeralQrPayload, 'sig'> = {
    v: 1,
    cid: typeof cardId === 'string' ? cardId.trim() : 'UNKNOWN_CARD',
    sub: typeof subjectHash === 'string' ? subjectHash.trim() : 'UNKNOWN_SUBJECT',
    ts: now,
    exp,
    nonce,
  };

  const canonical = toCanonicalString(unsigned);
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(canonical);
  const sig = hmac.digest('hex');

  return {
    ...unsigned,
    sig,
  };
}

/**
 * Verifies an incoming Dynamic Ephemeral QR code against:
 * 1. JSON structure & format compliance
 * 2. Expiration (180s TTL + allowed clock skew)
 * 3. Premature clock skew (future timestamp)
 * 4. Anti-Replay Nonce Cache (blocks screenshots / duplicate scans)
 * 5. HMAC-SHA256 Cryptographic Signature Authenticity
 */
export function verifyEphemeralQrToken(
  rawQrString: string,
  allowedClockSkewSeconds = 30,
  secret = DEFAULT_SHARED_SECRET
): EphemeralQrVerification {
  let parsed: unknown;
  try {
    parsed = typeof rawQrString === 'string' ? JSON.parse(rawQrString) : rawQrString;
  } catch {
    return {
      isValid: false,
      code: 'ERR_QR_MALFORMED',
      message: 'Invalid QR format: Payload is not valid JSON.',
    };
  }

  if (!isValidPayloadCandidate(parsed)) {
    return {
      isValid: false,
      code: 'ERR_QR_MALFORMED',
      message: 'Malformed QR: Missing required fields (v, cid, nonce, sig).',
    };
  }

  const payload = parsed as EphemeralQrPayload;
  const now = Math.floor(Date.now() / 1000);

  if (typeof payload.ts !== 'number' || !Number.isFinite(payload.ts)) {
    return {
      isValid: false,
      code: 'ERR_QR_MALFORMED',
      message: 'QR token timestamp is invalid.',
      payload,
    };
  }

  if (!isValidHex(payload.sig, 64)) {
    return {
      isValid: false,
      code: 'ERR_QR_INVALID_SIGNATURE',
      message: 'Cryptographic validation failed: Ephemeral QR signature is invalid or tampered.',
      payload,
    };
  }

  if (now > payload.exp + allowedClockSkewSeconds) {
    return {
      isValid: false,
      code: 'ERR_QR_EXPIRED',
      message: 'Ephemeral QR code has expired. Beneficiary must present a fresh dynamic QR.',
      payload,
    };
  }

  if (payload.ts > now + allowedClockSkewSeconds) {
    return {
      isValid: false,
      code: 'ERR_QR_CLOCK_SKEW',
      message: 'Invalid token issue time: Timestamp is in the future. Terminal clock unsynchronized.',
      payload,
    };
  }

  pruneExpiredNonces(now);

  if (seenNonces.has(payload.nonce)) {
    return {
      isValid: false,
      code: 'ERR_QR_REPLAYED',
      message: 'SECURITY ALERT: Replay detected! This dynamic QR token has already been presented and consumed.',
      payload,
    };
  }

  const canonical = toCanonicalString(payload);
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(canonical);
  const expectedSig = hmac.digest('hex');

  const sigBuffer = Buffer.from(payload.sig.toLowerCase(), 'utf-8');
  const expectedBuffer = Buffer.from(expectedSig.toLowerCase(), 'utf-8');

  if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
    return {
      isValid: false,
      code: 'ERR_QR_INVALID_SIGNATURE',
      message: 'Cryptographic validation failed: Ephemeral QR signature is invalid or tampered.',
      payload,
    };
  }

  seenNonces.set(payload.nonce, payload.exp);

  return {
    isValid: true,
    code: 'OK',
    message: 'Dynamic Ephemeral QR token verified successfully.',
    payload,
  };
}

/**
 * Prunes nonces whose validity window has passed to prevent memory bloat.
 */
function pruneExpiredNonces(currentEpochSeconds: number): void {
  for (const [nonce, exp] of seenNonces.entries()) {
    if (exp < currentEpochSeconds) {
      seenNonces.delete(nonce);
    }
  }
}

/**
 * Clears the anti-replay cache (used for unit and integration testing).
 */
export function clearEphemeralReplayCache(): void {
  seenNonces.clear();
}

