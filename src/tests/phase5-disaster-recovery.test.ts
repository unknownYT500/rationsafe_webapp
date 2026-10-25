// web/src/tests/phase5-disaster-recovery.test.ts
/**
 * Empirical Verification Suite for Phase 5:
 * 1. OpenTelemetry Distributed Tracing & W3C traceparent context propagation.
 * 2. PII-Scrubbed Structured Logging & Privacy Compliance (Aadhaar & phone masking).
 * 3. HTTP Server OpenTelemetry middleware & W3C traceresponse headers.
 * 4. 72-Hour Rural Blackout Disaster Recovery Simulation Drill with Edge Node & Central Reconciliation.
 */

import { createServer } from '../api/server.js';
import { TelemetryEngine } from '../core/telemetry.js';
import { StructuredLogger } from '../core/logger.js';
import { EdgeDistributionNode } from '../edge-node/edge-node.js';
import { generateNodeKeyPair } from '../core/crypto.js';
import type { Server } from 'http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let server: Server;
let baseUrl: string;

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`❌ Assertion Failed: ${message}`);
  }
  console.log(`  ✓ ${message}`);
}

async function runPhase5Tests() {
  console.log('================================================================');
  console.log('🧪 STARTING PHASE 5 PRODUCTION OBSERVABILITY & DISASTER RECOVERY SUITE');
  console.log('================================================================\n');

  // Start API server on random port with isolated test DB
  const isolatedDbDir = path.join(os.tmpdir(), `phase5_central_${Date.now()}`);
  fs.mkdirSync(isolatedDbDir, { recursive: true });
  const { CentralDatabase } = await import('../database/storage.js');
  const customDb = new CentralDatabase(path.join(isolatedDbDir, 'central_db.json'));
  const { app, db } = createServer(customDb);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const address = server.address() as any;
      baseUrl = `http://127.0.0.1:${address.port}`;
      console.log(`[Test Server] Live on ${baseUrl}\n`);
      resolve();
    });
  });

  try {
    // -------------------------------------------------------------------------
    // TEST SUITE 1: OpenTelemetry Distributed Tracing & W3C Context Propagation
    // -------------------------------------------------------------------------
    console.log('📋 SUITE 1: OpenTelemetry W3C Distributed Tracing Engine');
    TelemetryEngine.clear();

    // 1.1 Trace ID and Span ID generation
    const traceId = TelemetryEngine.generateTraceId();
    const spanId = TelemetryEngine.generateSpanId();
    assert(traceId.length === 32, 'W3C traceId is 32 hexadecimal characters (16 bytes)');
    assert(spanId.length === 16, 'W3C spanId is 16 hexadecimal characters (8 bytes)');

    // 1.2 Format and Parse W3C traceparent header
    const sampleContext = { version: '00', traceId, spanId, traceFlags: '01' };
    const formatted = TelemetryEngine.formatTraceparent(sampleContext);
    assert(formatted === `00-${traceId}-${spanId}-01`, 'Formats compliant W3C traceparent header');

    const parsed = TelemetryEngine.parseTraceparent(formatted);
    assert(parsed !== null, 'Parses valid W3C traceparent header');
    assert(parsed?.traceId === traceId, 'Extracted traceId matches original');
    assert(parsed?.spanId === spanId, 'Extracted spanId matches original');

    // 1.3 Child Span creation preserves traceId
    const childSpan = TelemetryEngine.startSpan('child_operation', { parent: sampleContext });
    assert(childSpan.context.traceId === traceId, 'Child span preserves root traceId');
    assert(childSpan.context.spanId !== spanId, 'Child span receives unique spanId');
    assert(childSpan.parentSpanId === spanId, 'Parent spanId correctly linked');
    childSpan.end('OK');

    // 1.4 Safe rejection of invalid traceparent headers
    assert(TelemetryEngine.parseTraceparent('') === null, 'Rejects empty header');
    assert(TelemetryEngine.parseTraceparent('malformed-header') === null, 'Rejects malformed header');
    assert(TelemetryEngine.parseTraceparent('01-abc-def-00') === null, 'Rejects unsupported version');
    assert(
      TelemetryEngine.parseTraceparent('00-00000000000000000000000000000000-1122334455667788-01') === null,
      'Rejects all-zero traceId'
    );
    console.log('✅ SUITE 1 PASSED: OpenTelemetry Tracing Engine fully verified.\n');

    // -------------------------------------------------------------------------
    // TEST SUITE 2: PII-Scrubbed Structured Logging & Privacy Verification
    // -------------------------------------------------------------------------
    console.log('📋 SUITE 2: PII-Scrubbed Structured Logger & Privacy Shield');
    StructuredLogger.clear();
    const logger = new StructuredLogger('test_service');

    // 2.1 Aadhaar number masking in string messages and JSON objects
    logger.info('Beneficiary registered with Aadhaar 987654321098', {
      aadhaar_number: '987654321098',
      aadhaar_spaced: '1234 5678 9012',
    });
    const log1 = StructuredLogger.getLogs()[0];
    assert(log1.message.includes('XXXX-XXXX-1098'), 'Aadhaar masked in log message');
    assert(!log1.message.includes('987654321098'), 'Raw Aadhaar never appears in log message');
    assert(log1.data?.aadhaar_number === 'XXXX-XXXX-1098', 'Aadhaar masked in structured field');
    assert(log1.data?.aadhaar_spaced === 'XXXX-XXXX-9012', 'Spaced Aadhaar masked in structured field');

    // 2.2 Phone number and confidential field redaction
    logger.audit('Grain dispense authorization recorded', {
      phoneNumber: '+91-9876543210',
      fullName: 'Lakshmi Bai',
      address: 'House 14, Ward 3, Rampur',
      yearly_income: 36000,
      privateKey: 'super_secret_ed25519_key',
    });
    const log2 = StructuredLogger.getLogs()[1];
    assert(log2.data?.phoneNumber === '+91-XXXXX-3210', 'Phone number masked to last 4 digits');
    assert(log2.data?.fullName === '[REDACTED_PII]', 'Citizen full name redacted');
    assert(log2.data?.address === '[REDACTED_PII]', 'Citizen address redacted');
    assert(log2.data?.yearly_income === '[REDACTED_PII]', 'Income level redacted');
    assert(log2.data?.privateKey === '[REDACTED_SECRET]', 'Cryptographic keys redacted');
    console.log('✅ SUITE 2 PASSED: PII Structured Logger fully verified.\n');

    // -------------------------------------------------------------------------
    // TEST SUITE 3: HTTP Server OpenTelemetry & W3C Header Propagation
    // -------------------------------------------------------------------------
    console.log('📋 SUITE 3: HTTP Server Distributed Trace Headers');

    // 3.1 Inbound request without traceparent receives new root trace
    const resNoTrace = await fetch(`${baseUrl}/api/v1/metrics`);
    assert(resNoTrace.status === 200, 'GET /api/v1/metrics returns 200 OK');
    const outTraceId = resNoTrace.headers.get('X-Trace-Id');
    const outTraceparent = resNoTrace.headers.get('traceparent');
    assert(outTraceId !== null && outTraceId.length === 32, 'X-Trace-Id header generated by middleware');
    assert(outTraceparent !== null && outTraceparent.startsWith('00-'), 'traceparent header returned');

    // 3.2 Inbound request with traceparent propagates traceId
    const incomingTraceId = '55555555555555555555555555555555';
    const incomingSpanId = 'aaaaaaaaaaaaaaaa';
    const incomingTraceparent = `00-${incomingTraceId}-${incomingSpanId}-01`;

    const resWithTrace = await fetch(`${baseUrl}/api/v1/metrics`, {
      headers: { traceparent: incomingTraceparent },
    });
    assert(resWithTrace.headers.get('X-Trace-Id') === incomingTraceId, 'Middleware preserves incoming traceId');
    assert(resWithTrace.headers.get('traceparent')?.includes(incomingTraceId) === true, 'traceparent header preserves traceId');

    // 3.3 Query Telemetry Spans and Logs endpoints
    const spansRes = await fetch(`${baseUrl}/api/v1/telemetry/spans`);
    const spansJson = await spansRes.json();
    assert(spansRes.status === 200 && spansJson.success === true, 'GET /api/v1/telemetry/spans returns 200');
    assert(spansJson.count > 0, 'Recorded HTTP spans captured in telemetry buffer');

    const logsRes = await fetch(`${baseUrl}/api/v1/telemetry/logs`);
    const logsJson = await logsRes.json();
    assert(logsRes.status === 200 && logsJson.success === true, 'GET /api/v1/telemetry/logs returns 200');
    assert(logsJson.count > 0, 'Recorded structured audit logs queryable');

    // 3.4 Clear Telemetry endpoint
    const clearRes = await fetch(`${baseUrl}/api/v1/telemetry/clear`, { method: 'POST' });
    const clearJson = await clearRes.json();
    assert(clearRes.status === 200 && clearJson.success === true, 'POST /api/v1/telemetry/clear resets buffer');
    console.log('✅ SUITE 3 PASSED: HTTP Telemetry Middleware fully verified.\n');

    // -------------------------------------------------------------------------
    // TEST SUITE 4: 72-Hour Rural Blackout Disaster Recovery Drill
    // -------------------------------------------------------------------------
    console.log('📋 SUITE 4: 72-Hour Rural Blackout & Disaster Recovery Simulation Drill');

    const testDir = path.join(os.tmpdir(), `phase5_blackout_${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    try {
      // 1. Setup Edge Node with 200 kg Lot Cap and Quota Leases
      const keys = await generateNodeKeyPair();
      const nodeId = 'node-blackout-drill-001';
      const edge = new EdgeDistributionNode({
        nodeId,
        nodeName: 'Bhimtal District FPS #42',
        privateKeyHex: keys.privateKeyHex,
        publicKeyHex: keys.publicKeyHex,
        dataDir: testDir,
      });

      // Central registers node and provisions 200 kg grain lot
      db.insertNode({
        id: nodeId,
        name: 'Bhimtal District FPS #42',
        public_key: keys.publicKeyHex,
        status: 'ONLINE',
        last_heartbeat: new Date().toISOString(),
        outbox_depth: 0,
        location: 'Bhimtal Rural Center',
      });

      const lotId = `lot-blackout-${Date.now()}`;
      db.insertLot({
        id: lotId,
        name: 'Emergency Reserve Rice',
        grain_type: 'RICE',
        total_quantity: 200.0,
        remaining_quantity: 200.0,
      });

      // Pre-allocate quota leases for 5 cards before blackout begins
      const cardIds: string[] = [];
      for (let c = 1; c <= 5; c++) {
        const cardId = `card-blackout-${c}-${Date.now()}`;
        cardIds.push(cardId);
        db.insertCard({
          id: cardId,
          person_id: `person-${c}`,
          status: 'ACTIVE',
          issued_at: new Date().toISOString(),
        });
        db.setQuotaLedger({
          id: `ledger-${c}`,
          card_id: cardId,
          node_id: nodeId,
          allocated_qty: 30.0,
          consumed_qty: 0,
          period_start: '2026-10-01',
        });
        // Allocate local offline lease on edge terminal
        edge.allocateLocalLease(cardId, 30.0);
      }

      // Provision local offline grain lot grant on edge terminal
      const grantId = `grant-blackout-${Date.now()}`;
      edge.setGrant(grantId, 200.0, Math.floor(Date.now() / 1000) + 86400 * 7);

      // 2. BEGIN SIMULATED 72-HOUR ELECTRICAL & CELLULAR BLACKOUT
      console.log('  ⚡ Blackout Initiated: Edge terminal isolated from central cloud.');

      let totalDispensedKg = 0;
      let transactionCount = 0;

      // Simulate 3 operational days during 72-hour blackout (5 dispenses/day = 15 dispenses)
      for (let day = 1; day <= 3; day++) {
        for (let tx = 0; tx < 5; tx++) {
          const cardId = cardIds[tx % cardIds.length];
          const qty = 5.0; // 5 kg per dispense
          totalDispensedKg += qty;
          transactionCount++;

          const result = await edge.issueProvisionalGrain({
            cardId,
            lotId,
            grantId,
            quantity: qty,
            idempotencyKey: `idem-blackout-d${day}-tx${tx}`,
          });

          assert(result.state === 'PROVISIONAL_ISSUE', `Day ${day} Tx ${tx + 1}: State is PROVISIONAL_ISSUE`);
          assert(result.token !== undefined, `Day ${day} Tx ${tx + 1}: Token generated locally`);
          assert(result.token!.payload.qty === 5.0, `Day ${day} Tx ${tx + 1}: Dispense quantity is 5.0 kg`);
          assert(result.token!.signature.length > 0, `Day ${day} Tx ${tx + 1}: Cryptographically signed offline`);
        }
      }

      assert(transactionCount === 15, 'All 15 offline blackout dispenses completed successfully');
      assert(totalDispensedKg === 75.0, 'Exactly 75.0 kg dispensed offline during 72-hour outage');
      assert(edge.getOutboxDepth() === 15, 'Outbox depth is exactly 15 pending tokens');

      // 3. END OF BLACKOUT: CELLULAR CONNECTIVITY RESTORED AFTER 72 HOURS
      console.log('  🌐 Cellular Network Restored: Initiating chunked batch reconciliation.');

      // Stream outbox tokens in bounded chunks of 5 (testing cursor chunking resilience)
      let syncedCount = 0;
      let offset = 0;
      const chunkSize = 5;

      while (true) {
        const batchInfo = edge.generateChunkedSyncBatch(chunkSize, offset);
        if (batchInfo.tokens.length === 0) break;

        const syncRes = await fetch(`${baseUrl}/api/v1/nodes/${nodeId}/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            batch_id: `sync-blackout-batch-${offset}`,
            tokens: batchInfo.tokens,
          }),
        });
        const syncJson = await syncRes.json();
        if (syncJson.accepted_count !== batchInfo.tokens.length) {
          console.log('SYNC FAILED ITEM ACKS:', JSON.stringify(syncJson.items, null, 2));
        }
        assert(syncRes.status === 200, `Chunk starting at offset ${offset} synced with 200 OK`);
        assert(syncJson.accepted_count === batchInfo.tokens.length, `All ${batchInfo.tokens.length} chunk tokens accepted`);

        syncedCount += syncJson.accepted_count;
        offset = batchInfo.nextOffset;
        if (batchInfo.remainingPendingCount === 0) break;
      }

      assert(syncedCount === 15, '100% of blackout transactions (15/15) atomically reconciled at Central');

      // 4. Test Idempotency: Re-submitting identical batch yields DUPLICATE without double deduction
      const reBatch = edge.generateChunkedSyncBatch(5, 0);
      const reSyncRes = await fetch(`${baseUrl}/api/v1/nodes/${nodeId}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          batch_id: 're-sync-check',
          tokens: reBatch.tokens,
        }),
      });
      const reSyncJson = await reSyncRes.json();
      assert(reSyncJson.accepted_count === 0, 'Zero tokens re-accepted upon duplicate sync');
      assert(reSyncJson.duplicate_count === reBatch.tokens.length, 'All re-submitted tokens flagged as DUPLICATE');

      console.log('✅ SUITE 4 PASSED: 72-Hour Blackout Disaster Recovery Drill 100% successful.\n');
    } finally {
      try {
        fs.rmSync(testDir, { recursive: true, force: true });
      } catch {}
    }

    console.log('================================================================');
    console.log('🎉 ALL PHASE 5 PRODUCTION OBSERVABILITY & DISASTER RECOVERY TESTS PASSED!');
    console.log('================================================================');
  } finally {
    server.close();
  }
}

runPhase5Tests().catch((err) => {
  console.error('\n❌ TEST SUITE FAILED WITH ERROR:', err);
  if (server) server.close();
  process.exit(1);
});
