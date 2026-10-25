// web/src/tests/phase3-resilience.test.ts
/**
 * Empirical Outbox Sync Resilience & Dynamic Ephemeral QR Verification Suite for Phase 3:
 * 1. Dynamic Ephemeral QR verification, HMAC signature validation, TTL expiration, and Anti-Replay Cache.
 * 2. Edge Node chunked outbox batch generation (LIMIT 50) preventing POS memory saturation.
 * 3. Exponential backoff & Dead-Letter Queue (DLQ) automatic quarantine preventing Head-of-Line blocking.
 * 4. Manual Dead-Letter Queue inspection and re-queue capabilities.
 * 5. REST API endpoint `POST /api/v1/qr/verify` verification with Zero-Trust JWT authorization.
 */

import { createServer } from '../api/server.js';
import { signUserToken } from '../api/auth.js';
import {
  generateEphemeralQrToken,
  verifyEphemeralQrToken,
  clearEphemeralReplayCache,
} from '../core/ephemeral-qr.js';
import { EdgeDistributionNode } from '../edge-node/edge-node.js';
import type { SignedProvisionalToken, ProvisionalTokenPayload } from '../core/types.js';
import type { Server } from 'http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let server: Server;
let baseUrl: string;

function createDummyToken(index: number): SignedProvisionalToken {
  const tid = `txn-phase3-${index}-${Date.now()}`;
  const payload: ProvisionalTokenPayload = {
    v: 1,
    tid,
    nid: 'node-edge-001',
    lid: 'lot-01',
    gid: 'grant-01',
    qid: `quota-card-${index}`,
    sub: `hash-card-${index}`,
    n: `nonce-${index}-${Date.now()}`,
    c: 1000 + index,
    qty: 5,
    unit: 'kg',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    kid: 'key-01',
  };
  return {
    id: `token-${index}-${Date.now()}`,
    txn_id: tid,
    payload,
    signature: `dummy-sig-${index}-3045022100`,
    key_id: 'key-01',
    nonce: payload.n,
    counter: payload.c,
    created_at: new Date().toISOString(),
  };
}

async function runPhase3Tests() {
  console.log('================================================================');
  console.log('🧪 STARTING PHASE 3 OUTBOX RESILIENCE & EPHEMERAL QR SUITE');
  console.log('================================================================\n');

  const { app } = createServer();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 3000;
      baseUrl = `http://localhost:${port}`;
      console.log(`[Test Server] Hardened Express server listening on ${baseUrl}\n`);
      resolve();
    });
  });

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, details?: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}${details ? ` -> ${details}` : ''}`);
      failed++;
    }
  }

  try {
    // -------------------------------------------------------------
    // Test 1: Dynamic Ephemeral QR Generation & Verification
    // -------------------------------------------------------------
    console.log('📋 Scenario 1: Ephemeral QR Token Generation & Verification');
    clearEphemeralReplayCache();

    const qrToken = generateEphemeralQrToken('CARD-AP-HYD-001', 'sub-hash-sunita-01', 180);

    assert(qrToken.v === 1, 'Token version is 1');
    assert(qrToken.cid === 'CARD-AP-HYD-001', 'Card ID matches beneficiary');
    assert(qrToken.nonce.length === 32, 'Nonce is 16-byte cryptographically secure hex');
    assert(qrToken.sig.length === 64, 'Signature is 64-char HMAC-SHA256 hex');

    const firstCheck = verifyEphemeralQrToken(JSON.stringify(qrToken));
    assert(firstCheck.isValid === true, 'Fresh Ephemeral QR token validates successfully');
    assert(firstCheck.code === 'OK', 'Result code is OK');
    assert(firstCheck.payload?.cid === 'CARD-AP-HYD-001', 'Payload extracted correctly');

    // -------------------------------------------------------------
    // Test 2: Anti-Replay Defense
    // -------------------------------------------------------------
    console.log('\n📋 Scenario 2: Anti-Replay Cache Defense');
    const replayCheck = verifyEphemeralQrToken(JSON.stringify(qrToken));
    assert(replayCheck.isValid === false, 'Duplicate QR scan rejected');
    assert(replayCheck.code === 'ERR_QR_REPLAYED', 'Result code is ERR_QR_REPLAYED');
    assert(replayCheck.message.includes('already been presented'), 'Replay error message explicitly flagged');

    // -------------------------------------------------------------
    // Test 3: Cryptographic Signature Tampering
    // -------------------------------------------------------------
    console.log('\n📋 Scenario 3: Cryptographic Signature Tampering Detection');
    const tamperedSigToken = {
      ...qrToken,
      nonce: '11112222333344445555666677778888', // different nonce with old signature
    };
    const tamperedCheck = verifyEphemeralQrToken(JSON.stringify(tamperedSigToken));
    assert(tamperedCheck.isValid === false, 'Tampered token rejected by HMAC check');
    assert(tamperedCheck.code === 'ERR_QR_INVALID_SIGNATURE', 'Result code is ERR_QR_INVALID_SIGNATURE');

    // -------------------------------------------------------------
    // Test 4: TTL Expiry Check
    // -------------------------------------------------------------
    console.log('\n📋 Scenario 4: Ephemeral QR Expiration Defense');
    const nowSec = Math.floor(Date.now() / 1000);
    const expiredPayload = {
      v: 1,
      cid: 'CARD-EXP-999',
      sub: 'masked-subject-hash',
      ts: nowSec - 300,
      exp: nowSec - 120, // Expired 2 minutes ago
      nonce: 'expirednonce12345678901234567890',
      sig: 'dummy-sig',
    };
    const expiredCheck = verifyEphemeralQrToken(JSON.stringify(expiredPayload));
    assert(expiredCheck.isValid === false, 'Expired QR code rejected');
    assert(expiredCheck.code === 'ERR_QR_EXPIRED', 'Result code is ERR_QR_EXPIRED');

    // -------------------------------------------------------------
    // Test 5: Edge Node Chunked Outbox Streaming (Limit 50)
    // -------------------------------------------------------------
    console.log('\n📋 Scenario 5: Edge Node Cursor-Based Chunked Outbox Batching');
    const testDataDir = path.join(os.tmpdir(), `rationsafe-edge-test-${Date.now()}`);
    fs.mkdirSync(testDataDir, { recursive: true });

    const edgeNode = new EdgeDistributionNode({
      nodeId: 'test-edge-node-01',
      nodeName: 'Test Node 01',
      privateKeyHex: '01'.repeat(32),
      publicKeyHex: '02'.repeat(32),
      dataDir: testDataDir,
    });

    // Enqueue 75 items into outbox
    for (let i = 0; i < 75; i++) {
      edgeNode.addToOutbox(createDummyToken(i));
    }

    const initialStats = edgeNode.getOutboxStats();
    assert(initialStats.PENDING === 75, 'Enqueued 75 tokens in PENDING state');
    assert(initialStats.TOTAL === 75, 'Total outbox items is 75');

    // Fetch chunk 1 with limit 50
    const chunk1 = edgeNode.generateChunkedSyncBatch(50, 0);
    assert(chunk1.tokens.length === 50, 'Chunk 1 strictly limited to 50 items (preventing OOM)');
    assert(chunk1.remainingPendingCount === 25, 'Remaining pending count accurately reported as 25');

    // Fetch chunk 2 using cursor (nextOffset)
    const chunk2 = edgeNode.generateChunkedSyncBatch(50, chunk1.nextOffset);
    assert(chunk2.tokens.length === 25, 'Chunk 2 retrieves remaining 25 items');
    assert(chunk2.remainingPendingCount === 0, 'Remaining pending count is now 0');

    // -------------------------------------------------------------
    // Test 6: Dead-Letter Queue (DLQ) Quarantine (Preventing HOL Blocking)
    // -------------------------------------------------------------
    console.log('\n📋 Scenario 6: DLQ Quarantine & Exponential Backoff');
    const poisonToken = chunk1.tokens[0];
    const poisonId = poisonToken.id;

    // Fail 4 times (under max 5)
    for (let attempt = 1; attempt <= 4; attempt++) {
      edgeNode.markOutboxItemFailed(poisonId, `Transient network error attempt ${attempt}`, 5);
      const stats = edgeNode.getOutboxStats();
      assert(stats.RETRYING === 1, `After attempt ${attempt}: item is in RETRYING state`);
    }

    // 5th failure exceeds threshold -> Automatic DLQ quarantine
    edgeNode.markOutboxItemFailed(poisonId, 'Permanent schema failure or rejection', 5);
    const postDlqStats = edgeNode.getOutboxStats();
    assert(postDlqStats.DEAD_LETTER === 1, 'Poison token quarantined into DEAD_LETTER queue');
    assert(postDlqStats.RETRYING === 0, 'Zero tokens in RETRYING state');

    // Healthy tokens remain unblocked!
    const unblockedChunk = edgeNode.generateChunkedSyncBatch(50);
    const unblockedIds = unblockedChunk.tokens.map((t) => t.id);
    assert(!unblockedIds.includes(poisonId), 'Quarantined poison token omitted from active sync batch');
    assert(unblockedChunk.tokens.length === 50, 'Healthy tokens stream without Head-of-Line blocking');

    // -------------------------------------------------------------
    // Test 7: DLQ Inspection and Manual Re-queue
    // -------------------------------------------------------------
    console.log('\n📋 Scenario 7: DLQ Inspection and Manual Re-queue');
    const dlqItems = edgeNode.getDeadLetterQueue();
    assert(dlqItems.length === 1, 'getDeadLetterQueue() returns 1 quarantined item');
    assert(dlqItems[0].id === poisonId, 'DLQ item matches poison token ID');
    assert(dlqItems[0].attempts === 5, 'DLQ item recorded 5 failed attempts');

    const requeued = edgeNode.requeueDeadLetter(poisonId);
    assert(requeued === true, 'requeueDeadLetter() successfully resets token to PENDING');
    const finalStats = edgeNode.getOutboxStats();
    assert(finalStats.DEAD_LETTER === 0, 'Dead letter count is now 0');
    assert(finalStats.PENDING === 75, 'Token restored to PENDING queue');

    // -------------------------------------------------------------
    // Test 8: REST API Endpoint POST /api/v1/qr/verify
    // -------------------------------------------------------------
    console.log('\n📋 Scenario 8: REST API POST /api/v1/qr/verify');
    clearEphemeralReplayCache();

    const operatorJwt = signUserToken({
      id: 'op-phase3-tester',
      name: 'Verification Officer',
      role: 'DISTRIBUTION_OPERATOR',
      node_id: 'test-edge-node-01',
    }, 'JWT_BEARER');

    const freshToken = generateEphemeralQrToken('CARD-API-9900', 'sub-hash-amina-01', 180);

    const res1 = await fetch(`${baseUrl}/api/v1/qr/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${operatorJwt}`,
      },
      body: JSON.stringify({ qr_payload: JSON.stringify(freshToken) }),
    });
    const data1 = await res1.json() as any;
    assert(res1.status === 200, 'POST /api/v1/qr/verify returns 200 OK');
    assert(data1.isValid === true, 'Response isValid is true');
    assert(data1.payload.cid === 'CARD-API-9900', 'Response payload.cid matches');

    // Immediate replay to API
    const res2 = await fetch(`${baseUrl}/api/v1/qr/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${operatorJwt}`,
      },
      body: JSON.stringify({ qr_payload: JSON.stringify(freshToken) }),
    });
    const data2 = await res2.json() as any;
    assert(res2.status === 400, 'Replay scan to API returns 400 Bad Request');
    assert(data2.code === 'ERR_QR_REPLAYED', 'API returns ERR_QR_REPLAYED code');

    // Cleanup tmp dir
    try {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    } catch {}

  } catch (err: any) {
    console.error('Unexpected exception during test run:', err);
    failed++;
  } finally {
    server.close();
    console.log('\n================================================================');
    console.log(`🏁 TEST SUITE COMPLETE: ${passed} PASSED | ${failed} FAILED`);
    console.log('================================================================\n');

    if (failed > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  }
}

runPhase3Tests();
