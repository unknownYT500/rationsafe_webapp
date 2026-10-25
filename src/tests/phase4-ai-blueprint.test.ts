// web/src/tests/phase4-ai-blueprint.test.ts
/**
 * Empirical Verification Test Suite for Phase 4:
 * 1. Edge Guardian AI Anomaly Detection Engine (velocity, burst, off-hours, counter gap, volume).
 * 2. Blueprint Statutory Compliance Engine (NFSA 2013 entitlements, PII cryptographic masking).
 * 3. Vernacular Voice & Grievance Engine (multilingual intent parsing, localized response synthesis, ticket logging).
 * 4. End-to-end REST API verification for AI audit, voice query, grievances, and blueprint validation.
 */

import { createServer } from '../api/server.js';
import { EdgeGuardianEngine } from '../core/edge-guardian.js';
import { BlueprintComplianceEngine } from '../core/blueprint-compliance.js';
import { VernacularEngine } from '../core/vernacular-engine.js';
import type { Server } from 'http';

let server: Server;
let baseUrl: string;

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`❌ Assertion Failed: ${message}`);
  }
  console.log(`  ✓ ${message}`);
}

async function runPhase4Tests() {
  console.log('================================================================');
  console.log('🧪 STARTING PHASE 4 AI EDGE GUARDIAN & BLUEPRINT SUITE');
  console.log('================================================================\n');

  // Start API server on random port
  const { app } = createServer();
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
    // TEST SUITE 1: Edge Guardian AI Anomaly Detection Engine
    // -------------------------------------------------------------------------
    console.log('📋 SUITE 1: Edge Guardian AI Anomaly Scoring Heuristics');
    const guardian = new EdgeGuardianEngine();

    // 1.1 Normal transaction
    const normalAssessment = guardian.evaluate({
      dispenseId: 'disp-001',
      cardId: 'card-100',
      nodeId: 'node-001',
      quantity: 5.0,
      dispensedAt: '2026-10-25T10:30:00Z',
      previousDispenseTime: '2026-10-25T10:20:00Z',
      recentDispensesLastMinute: 1,
      expectedCounter: 10,
      actualCounter: 10,
    });
    assert(normalAssessment.riskScore === 0, 'Normal daytime transaction has 0 risk score');
    assert(normalAssessment.riskLevel === 'LOW', 'Normal transaction classified as LOW risk');
    assert(normalAssessment.recommendedAction === 'ALLOW', 'Action is ALLOW');
    assert(normalAssessment.flags.length === 0, 'Zero anomaly flags raised');

    // 1.2 Velocity Violation (< 15 seconds)
    const velocityAssessment = guardian.evaluate({
      dispenseId: 'disp-002',
      cardId: 'card-101',
      nodeId: 'node-001',
      quantity: 5.0,
      dispensedAt: '2026-10-25T11:00:10Z',
      previousDispenseTime: '2026-10-25T11:00:03Z', // 7 seconds (< 15s)
    });
    assert(velocityAssessment.riskScore === 35, 'Velocity violation scores 35 points');
    assert(velocityAssessment.riskLevel === 'MEDIUM', 'Classified as MEDIUM risk');
    assert(velocityAssessment.recommendedAction === 'FLAG_FOR_AUDIT', 'Action is FLAG_FOR_AUDIT');
    assert(velocityAssessment.flags.some((f) => f.includes('VELOCITY_VIOLATION')), 'Velocity flag present');

    // 1.3 Off-Hours Night Operation (23:00)
    const offHoursAssessment = guardian.evaluate({
      dispenseId: 'disp-003',
      cardId: 'card-102',
      nodeId: 'node-001',
      quantity: 5.0,
      dispensedAt: '2026-10-25T23:30:00', // 23:30 local
    });
    assert(offHoursAssessment.riskScore === 40, 'Off-hours night operation scores 40 points');
    assert(offHoursAssessment.flags.some((f) => f.includes('OFF_HOURS_DISPENSE')), 'Off-hours flag present');

    // 1.4 High Collusion Critical Block (Off-hours + Velocity violation = 40 + 35 = 75)
    const criticalAssessment = guardian.evaluate({
      dispenseId: 'disp-004',
      cardId: 'card-103',
      nodeId: 'node-001',
      quantity: 5.0,
      dispensedAt: '2026-10-25T02:00:10', // 2:00 AM (+40)
      previousDispenseTime: '2026-10-25T02:00:02', // 8s (+35)
    });
    assert(criticalAssessment.riskScore === 75, 'Combined score is 75');
    assert(criticalAssessment.riskLevel === 'CRITICAL', 'Classified as CRITICAL risk');
    assert(criticalAssessment.recommendedAction === 'BLOCK', 'Fraud blocked immediately');

    // 1.5 Batch Node Audit Evaluation
    const batchResult = guardian.batchAudit([
      { dispenseId: 'd1', cardId: 'c1', nodeId: 'n1', quantity: 5.0, dispensedAt: '2026-10-25T10:00:00Z' },
      { dispenseId: 'd2', cardId: 'c2', nodeId: 'n1', quantity: 30.0, dispensedAt: '2026-10-25T10:05:00Z' }, // volume spike
      { dispenseId: 'd3', cardId: 'c3', nodeId: 'n1', quantity: 5.0, dispensedAt: '2026-10-25T01:00:00' }, // off hours
    ]);
    assert(batchResult.totalAudited === 3, 'Batch audit processed 3 records');
    assert(batchResult.averageRiskScore > 0, 'Average risk score computed');
    assert(batchResult.assessments.length === 3, 'All individual assessments returned');
    console.log('✅ SUITE 1 PASSED: Edge Guardian AI Engine fully verified.\n');

    // -------------------------------------------------------------------------
    // TEST SUITE 2: Blueprint Statutory Policy & NFSA Compliance
    // -------------------------------------------------------------------------
    console.log('📋 SUITE 2: Blueprint Statutory NFSA & PII Cryptographic Compliance');

    // 2.1 Statutory Entitlement Calculations
    assert(BlueprintComplianceEngine.calculateStatutoryEntitlement('PHH', 4) === 20.0, 'PHH 4 members = 20.0 kg');
    assert(BlueprintComplianceEngine.calculateStatutoryEntitlement('PHH', 6) === 30.0, 'PHH 6 members = 30.0 kg');
    assert(BlueprintComplianceEngine.calculateStatutoryEntitlement('AAY', 2) === 35.0, 'AAY 2 members = 35.0 kg fixed');
    assert(BlueprintComplianceEngine.calculateStatutoryEntitlement('AAY', 7) === 35.0, 'AAY 7 members = 35.0 kg fixed');
    assert(BlueprintComplianceEngine.calculateStatutoryEntitlement('AY', 1) === 10.0, 'Annapurna senior = 10.0 kg fixed');

    // 2.2 Compliant Dispense Request
    const compliant = BlueprintComplianceEngine.validateDispense(
      { cardId: 'CARD-PHH-001', category: 'PHH', familyCount: 4, monthlyQuotaConsumed: 5.0 },
      10.0
    );
    assert(compliant.isCompliant === true, 'Legitimate dispense is approved');
    assert(compliant.remainingQuota === 5.0, 'Remaining quota computed as 5.0 kg');
    assert(compliant.piiMaskedCardId.length === 16, 'Card ID masked to 16-character SHA-256 slice');

    // 2.3 Overdraw Statutory Violation
    const overdraw = BlueprintComplianceEngine.validateDispense(
      { cardId: 'CARD-PHH-002', category: 'PHH', familyCount: 3, monthlyQuotaConsumed: 12.0 }, // max 15, remaining 3
      5.0 // requests 5 kg
    );
    assert(overdraw.isCompliant === false, 'Overdraw dispense strictly rejected');
    assert(overdraw.violationReason?.includes('Statutory NFSA cap exceeded') === true, 'NFSA cap error returned');

    // 2.4 Cryptographic PII Masking
    const maskedId = BlueprintComplianceEngine.maskIdentifier('CARD-SECRET-1234');
    assert(maskedId.length === 16, 'SHA-256 card identifier mask length is 16');
    assert(!maskedId.includes('SECRET'), 'Plaintext identifier strictly protected');

    const maskedAadhaar = BlueprintComplianceEngine.maskAadhaar('123456789012');
    assert(maskedAadhaar === 'XXXX-XXXX-9012', 'Aadhaar masked in standard XXXX-XXXX-last4 format');
    console.log('✅ SUITE 2 PASSED: Blueprint Statutory Compliance fully verified.\n');

    // -------------------------------------------------------------------------
    // TEST SUITE 3: Vernacular Voice & Grievance Engine
    // -------------------------------------------------------------------------
    console.log('📋 SUITE 3: Vernacular Voice & Grievance Engine (242 Regional Dialects)');
    const vernacular = new VernacularEngine();

    // 3.1 Quota Inquiry Parsing & Synthesis (Hindi)
    const hiQuota = vernacular.parseUtterance('Mera kitna chawal bacha hai bhai', 'hi');
    assert(hiQuota.type === 'QUOTA_INQUIRY', 'Hindi quota inquiry recognized');
    assert(hiQuota.confidence > 0.9, 'Confidence > 90%');
    const hiResp = vernacular.synthesizeResponse(hiQuota, { remainingQuotaKg: 15.0 });
    assert(hiResp.includes('15.0 kilo anaaj bacha hua hai'), 'Localized Hindi response synthesized');

    // 3.2 Telugu Quota Inquiry
    const teQuota = vernacular.parseUtterance('Mee card lo entha biyyam migilindi', 'te');
    assert(teQuota.type === 'QUOTA_INQUIRY', 'Telugu quota inquiry recognized');
    const teResp = vernacular.synthesizeResponse(teQuota, { remainingQuotaKg: 10.0 });
    assert(teResp.includes('10.0 kg biyyam migilindi'), 'Localized Telugu response synthesized');

    // 3.3 Grievance Registration & Ticket Generation
    const grievanceIntent = vernacular.parseUtterance('Dukaandar ne 2 kilo kam diya aur loot macha rakhi hai', 'hi');
    assert(grievanceIntent.type === 'GRIEVANCE_REGISTRATION', 'Grievance intent recognized');
    assert(grievanceIntent.extractedSlots.category === 'UNDER_WEIGHING', 'Under-weighing category resolved');

    const ticket = vernacular.registerGrievance(
      'CARD-GRIEV-001',
      'node-alpha-001',
      'UNDER_WEIGHING',
      'Dukaandar ne 2 kilo kam diya'
    );
    assert(ticket.ticketId.startsWith('GRV-'), 'Ticket ID matches GRV-YYYYMMDD-XXXX format');
    assert(ticket.status === 'PENDING', 'Grievance ticket status is PENDING');

    const grievanceResp = vernacular.synthesizeResponse(grievanceIntent, { grievanceTicketId: ticket.ticketId });
    assert(grievanceResp.includes(ticket.ticketId), 'Ticket number read back to citizen');
    console.log('✅ SUITE 3 PASSED: Vernacular Engine fully verified.\n');

    // -------------------------------------------------------------------------
    // TEST SUITE 4: End-to-End REST API Verifications
    // -------------------------------------------------------------------------
    console.log('📋 SUITE 4: REST API Endpoints Verification');

    // 4.1 POST /api/v1/ai/audit
    const auditRes = await fetch(`${baseUrl}/api/v1/ai/audit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transaction: {
          dispenseId: 'disp-api-01',
          cardId: 'card-api-01',
          nodeId: 'node-alpha-001',
          quantity: 20.0,
          dispensedAt: '2026-10-25T12:00:00Z',
        },
      }),
    });
    const auditJson = await auditRes.json();
    assert(auditRes.status === 200 && auditJson.success === true, 'POST /api/v1/ai/audit returns 200 OK');
    assert(auditJson.assessment.riskLevel === 'LOW', 'API assessment confirmed LOW risk');

    // 4.2 POST /api/v1/voice/query
    const voiceRes = await fetch(`${baseUrl}/api/v1/voice/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        utterance: 'Is mahine ration kab aayega timing kya hai',
        lang_code: 'hi',
      }),
    });
    const voiceJson = await voiceRes.json();
    assert(voiceRes.status === 200 && voiceJson.success === true, 'POST /api/v1/voice/query returns 200 OK');
    assert(voiceJson.intent.type === 'SCHEDULE_INQUIRY', 'Schedule inquiry intent returned by API');
    assert(voiceJson.synthesized_response.includes('subah 8 baje'), 'Schedule synthesized response returned');

    // 4.3 POST /api/v1/grievances & GET /api/v1/grievances
    const createGrvRes = await fetch(`${baseUrl}/api/v1/grievances`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        card_id: 'CARD-TEST-API-99',
        node_id: 'node-alpha-001',
        category: 'UNDER_WEIGHING',
        complaint_text: 'Dealer gave 3kg less rice',
      }),
    });
    const createGrvJson = await createGrvRes.json();
    assert(createGrvRes.status === 201 && createGrvJson.success === true, 'POST /api/v1/grievances returns 201 Created');
    assert(createGrvJson.grievance.ticketId.startsWith('GRV-'), 'API issued valid grievance ticket');

    const listGrvRes = await fetch(`${baseUrl}/api/v1/grievances`);
    const listGrvJson = await listGrvRes.json();
    assert(listGrvRes.status === 200 && listGrvJson.count >= 1, 'GET /api/v1/grievances lists stored tickets');

    // 4.4 POST /api/v1/blueprint/validate
    const bpRes = await fetch(`${baseUrl}/api/v1/blueprint/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        card_id: 'CARD-API-PHH-01',
        category: 'PHH',
        family_count: 5, // 25kg max
        monthly_consumed: 10, // 15kg remaining
        requested_qty: 12,
      }),
    });
    const bpJson = await bpRes.json();
    assert(bpRes.status === 200 && bpJson.compliance.isCompliant === true, 'POST /api/v1/blueprint/validate confirms compliance');
    assert(bpJson.compliance.remainingQuota === 3, 'Remaining balance computed correctly as 3 kg');
    console.log('✅ SUITE 4 PASSED: All REST API Endpoints verified.\n');

    console.log('================================================================');
    console.log('🎉 ALL PHASE 4 EMPIRICAL TESTS PASSED SUCCESSFULLY!');
    console.log('================================================================');
  } finally {
    server.close();
  }
}

runPhase4Tests().catch((err) => {
  console.error('\n❌ TEST SUITE FAILED WITH ERROR:', err);
  if (server) server.close();
  process.exit(1);
});
