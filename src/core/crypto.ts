// src/core/crypto.ts
import * as ed from '@noble/ed25519';
import crypto from 'node:crypto';
import type { ProvisionalTokenPayload } from './types.js';

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
  return crypto.createHash('sha256').update(cardId).digest('hex');
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
    const canonicalString = canonicalJson(payload);
    const messageBytes = Buffer.from(canonicalString, 'utf-8');
    const signatureBytes = Buffer.from(signatureHex, 'hex');
    const publicKeyBytes = Buffer.from(publicKeyHex, 'hex');

    return await ed.verifyAsync(signatureBytes, messageBytes, publicKeyBytes);
  } catch {
    return false;
  }
}
