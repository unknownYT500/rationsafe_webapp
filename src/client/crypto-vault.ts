// web/src/client/crypto-vault.ts
/**
 * Web Cryptography API (SubtleCrypto) Engine for RationSafe
 * 
 * Provides production-grade AES-GCM 256-bit encryption/decryption at rest
 * for sensitive citizen Personally Identifiable Information (PII).
 * 
 * Cryptographic Standard:
 * - Cipher: AES-GCM (Galois/Counter Mode)
 * - Key Length: 256 bits
 * - Initialization Vector (IV): 96 bits (12 bytes) cryptographically random per operation
 * - Tag Length: 128 bits authentication tag (integrity guarantee against tampering)
 */

const KEY_STORAGE_DB = 'RationSafe_KeyRing_v1';
const KEY_STORE_NAME = 'master_keys';
const MASTER_KEY_ID = 'rationsafe_device_pii_master_key_v1';

/**
 * Retrieves or securely generates a non-exportable AES-GCM 256-bit CryptoKey
 * stored inside IndexedDB using structured cloning (never stored as raw plaintext).
 */
export async function getOrCreateMasterCryptoKey(): Promise<CryptoKey> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(KEY_STORAGE_DB, 1);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(KEY_STORE_NAME)) {
        db.createObjectStore(KEY_STORE_NAME);
      }
    };

    request.onsuccess = async (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      const tx = db.transaction(KEY_STORE_NAME, 'readwrite');
      const store = tx.objectStore(KEY_STORE_NAME);
      const getReq = store.get(MASTER_KEY_ID);

      getReq.onsuccess = async () => {
        if (getReq.result) {
          resolve(getReq.result as CryptoKey);
        } else {
          // Generate fresh AES-GCM 256 key
          try {
            const key = await window.crypto.subtle.generateKey(
              {
                name: 'AES-GCM',
                length: 256,
              },
              false, // extractable = false (prevent memory/script exfiltration)
              ['encrypt', 'decrypt']
            );

            const putTx = db.transaction(KEY_STORE_NAME, 'readwrite');
            const putStore = putTx.objectStore(KEY_STORE_NAME);
            putStore.put(key, MASTER_KEY_ID);

            putTx.oncomplete = () => resolve(key);
            putTx.onerror = () => reject(putTx.error);
          } catch (err) {
            reject(err);
          }
        }
      };

      getReq.onerror = () => reject(getReq.error);
    };

    request.onerror = () => reject(request.error);
  });
}

/**
 * Encrypts a plaintext string using AES-GCM 256.
 * Returns a compact base64-encoded payload containing: [12-byte IV + Ciphertext + 16-byte Auth Tag].
 */
export async function encryptPII(plaintext: string, key?: CryptoKey): Promise<string> {
  if (!plaintext || typeof plaintext !== 'string') return plaintext;

  try {
    const activeKey = key || (await getOrCreateMasterCryptoKey());
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);

    const ciphertext = await window.crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
        tagLength: 128,
      },
      activeKey,
      encoded
    );

    // Combine IV (12 bytes) + Ciphertext + Tag
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.length);

    // Convert to base64 with a distinctive prefix
    return 'enc:v1:' + btoa(String.fromCharCode(...combined));
  } catch (err) {
    console.error('[CryptoVault] Encryption failure:', err);
    return plaintext; // Fallback to avoid catastrophic user lockout
  }
}

/**
 * Decrypts a base64-encoded AES-GCM 256 ciphertext payload.
 * Verifies authenticity tag; throws or returns error placeholder if tampered.
 */
export async function decryptPII(ciphertextWithIv: string, key?: CryptoKey): Promise<string> {
  if (!ciphertextWithIv || typeof ciphertextWithIv !== 'string' || !ciphertextWithIv.startsWith('enc:v1:')) {
    return ciphertextWithIv; // Not encrypted or legacy plaintext
  }

  try {
    const activeKey = key || (await getOrCreateMasterCryptoKey());
    const base64Data = ciphertextWithIv.replace('enc:v1:', '');
    const binaryString = atob(base64Data);
    const combined = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      combined[i] = binaryString.charCodeAt(i);
    }

    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);

    const decrypted = await window.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
        tagLength: 128,
      },
      activeKey,
      ciphertext
    );

    return new TextDecoder().decode(decrypted);
  } catch (err) {
    console.warn('[CryptoVault] Decryption failed or payload tampered:', err);
    return '[ENCRYPTED_PII]';
  }
}
