// src/core/crypto.ts
import * as ed from '@noble/ed25519';
import crypto from 'node:crypto';
import type { ProvisionalTokenPayload } from './types.js';

function assertHexString(value: string, length?: number, label = 'hex data'): void {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${label} must be a valid hex string.`);
  }
  if (typeof length === 'number' && value.length !== length) {
    throw new Error(`${label} must be ${length} hex characters long.`);
  }
}

function assertValidTokenPayload(payload: ProvisionalTokenPayload): void {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Token payload is required.');
  }
  const required: Array<keyof ProvisionalTokenPayload> = ['v', 'tid', 'nid', 'lid', 'gid', 'qid', 'sub', 'n', 'c', 'qty', 'unit', 'iat', 'exp', 'kid'];
  for (const key of required) {
    if (payload[key] === undefined || payload[key] === null) {
      throw new Error(`Token payload is missing required field: ${String(key)}`);
    }
  }
  if (payload.v !== 1) {
    throw new Error('Token payload version must be 1.');
  }
  if (!Number.isFinite(payload.qty) || payload.qty <= 0) {
    throw new Error('Token quantity must be a finite positive number.');
  }
  if (payload.unit !== 'kg') {
    throw new Error('Token unit must be kg.');
  }
  if (!Number.isFinite(payload.iat) || !Number.isFinite(payload.exp) || payload.exp <= payload.iat) {
    throw new Error('Token validity window is invalid.');
  }
}

/**
 * Deterministic JSON stringifier (canonical JSON serialization).
 * Sorts object keys recursively to ensure deterministic cryptographic digests.
 */
export function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    return '[' + obj.map((item) => canonicalJson(item)).join(',') + ']';
  }

  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const entries = keys.map((key) => {
    const val = (obj as Record<string, unknown>)[key];
    return `${JSON.stringify(key)}:${canonicalJson(val)}`;
  });

  return '{' + entries.join(',') + '}';
}

/**
 * Derives a SHA-256 hash of a card_id to preserve privacy (no PII in tokens).
 */
export function hashCardId(cardId: string): string {
  const value = typeof cardId === 'string' ? cardId.trim() : '';
  if (!value) {
    throw new Error('Card ID is required for hashing.');
  }
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Generates an Ed25519 KeyPair for a Distribution Node or Central Authority.
 */
export async function generateNodeKeyPair(): Promise<{
  privateKeyHex: string;
  publicKeyHex: string;
}> {
  const keys = await ed.keygenAsync();
  const privHex = Buffer.from(keys.secretKey).toString('hex');
  const pubHex = Buffer.from(keys.publicKey).toString('hex');
  return { privateKeyHex: privHex, publicKeyHex: pubHex };
}

/**
 * Signs a canonical token payload with the Node's Ed25519 private key.
 */
export async function signTokenPayload(
  payload: ProvisionalTokenPayload,
  privateKeyHex: string
): Promise<string> {
  if (privateKeyHex.length !== 64 && privateKeyHex.length !== 128) {
    throw new Error('Private key must be 64 or 128 hex characters long.');
  }
  assertHexString(privateKeyHex, undefined, 'Private key');

  const canonicalString = canonicalJson(payload);
  const messageBytes = Buffer.from(canonicalString, 'utf-8');
  const privateKeyBytes = Buffer.from(privateKeyHex, 'hex');

  const signatureBytes = await ed.signAsync(messageBytes, privateKeyBytes);
  return Buffer.from(signatureBytes).toString('hex');
}

/**
 * Verifies an Ed25519 signature against the canonical token payload and public key.
 */
export async function verifyTokenPayload(
  payload: ProvisionalTokenPayload,
  signatureHex: string,
  publicKeyHex: string
): Promise<boolean> {
  try {
    assertValidTokenPayload(payload);
    if (typeof signatureHex !== 'string' || signatureHex.length === 0) {
      return false;
    }
    assertHexString(publicKeyHex, 64, 'Public key');

    const canonicalString = canonicalJson(payload);
    const messageBytes = Buffer.from(canonicalString, 'utf-8');
    const signatureBytes = Buffer.from(signatureHex, 'hex');
    const publicKeyBytes = Buffer.from(publicKeyHex, 'hex');

    return await ed.verifyAsync(signatureBytes, messageBytes, publicKeyBytes);
  } catch {
    return false;
  }
}

