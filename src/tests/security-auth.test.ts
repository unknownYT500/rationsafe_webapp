// web/src/tests/security-auth.test.ts
/**
 * Empirical Security & Identity Verification Suite for Phase 2:
 * 1. Zero-Trust Identity (JWT signing, verification, and tampering detection)
 * 2. Role-Based Access Control (RBAC enforcement across operator, supervisor, admin tiers)
 * 3. WebAuthn FIDO2 Biometric Challenge/Attestation verification
 * 4. Express 5 Security Middleware Suite (Helmet CSP/HSTS and Rate Limiting)
 */

import { createServer } from '../api/server.js';
import { signUserToken, verifyUserToken } from '../api/auth.js';
import type { Server } from 'http';

let server: Server;
let baseUrl: string;

async function runTestSuite() {
  console.log('================================================================');
  console.log('🧪 STARTING PHASE 2 EMPIRICAL SECURITY & IDENTITY TEST SUITE');
  console.log('================================================================\n');

  const { app } = createServer();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 3000;
      baseUrl = `http://localhost:${port}`;
      console.log(`[Test Server] Hardened Express 5 server listening on ${baseUrl}\n`);
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
    // Test 1: Unit Test - JWT Token Generation and Verification
    // -------------------------------------------------------------
    console.log('📋 Scenario 1: Cryptographic JWT Minting & Tamper Detection');
    const validToken = signUserToken({
      id: 'operator-secure-01',
      name: 'Priya Sharma',
      role: 'DISTRIBUTION_OPERATOR',
      node_id: 'node-alpha-001',
    }, 'JWT_BEARER');

    const decoded = verifyUserToken(validToken);
    assert(decoded !== null, 'Valid JWT token successfully decodes and verifies');
    assert(decoded?.id === 'operator-secure-01', 'Decoded subject matches operator ID');
    assert(decoded?.role === 'DISTRIBUTION_OPERATOR', 'Decoded claims include exact RBAC role');

    // Tampered token test (altering payload signature)
    const tamperedToken = validToken.slice(0, -6) + 'xxxxxx';
    const tamperedDecoded = verifyUserToken(tamperedToken);
    assert(tamperedDecoded === null, 'Tampered token fails signature verification and returns null');

    // -------------------------------------------------------------
    // Test 2: Helmet Security Headers Enforcement
    // -------------------------------------------------------------
    console.log('\n📋 Scenario 2: Express 5 Helmet Security Headers Verification');
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert(healthRes.status === 200, 'Health endpoint responds with HTTP 200');
    assert(
      healthRes.headers.get('x-frame-options') === 'DENY',
      'X-Frame-Options is strictly DENY (Clickjacking protection active)'
    );
    assert(
      healthRes.headers.get('x-content-type-options') === 'nosniff',
      'X-Content-Type-Options is nosniff (MIME sniffing prevention active)'
    );
    assert(
      healthRes.headers.has('content-security-policy'),
      'Strict Content-Security-Policy (CSP) is active'
    );

    // -------------------------------------------------------------
    // Test 3: Unauthenticated Access Rejection
    // -------------------------------------------------------------
    console.log('\n📋 Scenario 3: Protected Endpoint Access Control (Require Auth)');
    const unauthRes = await fetch(`${baseUrl}/api/v1/admin/reset`, { method: 'POST' });
    const unauthBody = await unauthRes.json();
    assert(
      unauthRes.status === 401,
      'Unauthenticated request to /api/v1/admin/reset rejected with HTTP 401',
      `Got ${unauthRes.status}`
    );
    assert(
      unauthBody.code === 'ERR_AUTH_UNAUTHORIZED',
      'Returns standardized error code ERR_AUTH_UNAUTHORIZED'
    );

    // -------------------------------------------------------------
    // Test 4: Role-Based Access Control (RBAC) Privilege Enforcement
    // -------------------------------------------------------------
    console.log('\n📋 Scenario 4: Role-Based Access Control (RBAC) Least-Privilege');
    const operatorToken = signUserToken({
      id: 'operator-002',
      name: 'Ramesh Patel',
      role: 'DISTRIBUTION_OPERATOR',
      node_id: 'node-alpha-001',
    });

    const forbiddenRes = await fetch(`${baseUrl}/api/v1/admin/reset`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${operatorToken}`,
      },
    });
    const forbiddenBody = await forbiddenRes.json();
    assert(
      forbiddenRes.status === 403,
      'DISTRIBUTION_OPERATOR forbidden from calling /api/v1/admin/reset (HTTP 403)',
      `Got ${forbiddenRes.status}`
    );
    assert(
      forbiddenBody.code === 'ERR_AUTH_FORBIDDEN',
      'Returns standardized error code ERR_AUTH_FORBIDDEN'
    );

    // Administrator token permitted
    const adminToken = signUserToken({
      id: 'sysadmin-001',
      name: 'Dr. Vikram Sarabhai',
      role: 'ADMINISTRATOR',
    });

    const adminRes = await fetch(`${baseUrl}/api/v1/admin/reset`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
      },
    });
    const adminBody = await adminRes.json();
    assert(
      adminRes.status === 200,
      'ADMINISTRATOR token successfully authorized for /api/v1/admin/reset (HTTP 200)'
    );
    assert(adminBody.success === true, 'Admin reset action successfully completed');

    // -------------------------------------------------------------
    // Test 5: WebAuthn FIDO2 Biometric Challenge Ceremony
    // -------------------------------------------------------------
    console.log('\n📋 Scenario 5: WebAuthn FIDO2 Biometric Challenge Ceremony');
    const challengeRes = await fetch(`${baseUrl}/api/v1/auth/webauthn/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: 'bio-operator-01' }),
    });
    const challengeBody = await challengeRes.json();
    assert(challengeRes.status === 200, 'WebAuthn challenge endpoint returns HTTP 200');
    assert(Boolean(challengeBody.challenge), 'Cryptographic random challenge returned');
    assert(Boolean(challengeBody.ticket), 'Session challenge ticket generated');

    const verifyRes = await fetch(`${baseUrl}/api/v1/auth/webauthn/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticket: challengeBody.ticket,
        clientDataJSON: Buffer.from(JSON.stringify({ challenge: challengeBody.challenge })).toString('base64url'),
        user_id: 'bio-operator-01',
        role: 'DISTRIBUTION_OPERATOR',
      }),
    });
    const verifyBody = await verifyRes.json();
    assert(verifyRes.status === 200, 'WebAuthn verification succeeds and issues session token');
    assert(verifyBody.auth_method === 'WEBAUTHN_FIDO2', 'Auth method recorded as WEBAUTHN_FIDO2');
    assert(Boolean(verifyBody.token), 'Cryptographic JWT token returned for biometric session');

    // -------------------------------------------------------------
    // Test 6: Sliding-Window Rate Limiter Protection
    // -------------------------------------------------------------
    console.log('\n📋 Scenario 6: Sliding-Window Rate Limiter Flooding Defense');
    let throttled = false;
    let attemptsCount = 0;
    // Fire rapid requests against admin endpoint (limit is 10 req / 15 min)
    for (let i = 0; i < 15; i++) {
      attemptsCount++;
      const res = await fetch(`${baseUrl}/api/v1/admin/reset`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${adminToken}` },
      });
      if (res.status === 429) {
        throttled = true;
        const errJson = await res.json();
        assert(
          errJson.code === 'ERR_ADMIN_RATE_LIMIT_EXCEEDED',
          `Rate limiter correctly triggered HTTP 429 on request #${attemptsCount} with ERR_ADMIN_RATE_LIMIT_EXCEEDED`
        );
        break;
      }
    }
    assert(throttled, 'Rate limiter successfully throttled burst requests to protected admin endpoint');

  } catch (err: any) {
    console.error('💥 Unexpected test harness failure:', err);
    failed++;
  } finally {
    server.close();
    console.log('\n================================================================');
    console.log(`🏁 TEST RESULTS: ${passed} PASSED | ${failed} FAILED`);
    console.log('================================================================');
    if (failed > 0) {
      process.exit(1);
    }
  }
}

runTestSuite();
