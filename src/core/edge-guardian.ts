// src/core/edge-guardian.ts
/**
 * Edge Guardian AI Anomaly Detection Engine (TypeScript / Web Implementation)
 *
 * Replicates and extends on-device edge heuristics for centralized server-side
 * and cloud node audit evaluation under the Adaption Labs AI framework.
 */

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type GuardianAction = 'ALLOW' | 'FLAG_FOR_AUDIT' | 'REQUIRE_SUPERVISOR_PIN' | 'BLOCK';

export interface EdgeGuardianAssessment {
  riskScore: number;
  riskLevel: RiskLevel;
  flags: string[];
  recommendedAction: GuardianAction;
  assessedAt: string;
}

export interface DispenseAuditContext {
  dispenseId: string;
  cardId: string;
  nodeId: string;
  quantity: number;
  dispensedAt?: string;
  previousDispenseTime?: string;
  recentDispensesLastMinute?: number;
  expectedCounter?: number;
  actualCounter?: number;
}

function safeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function safeIsoDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export class EdgeGuardianEngine {
  /**
   * Evaluates a single dispense event against the 5-point Edge Guardian heuristic matrix:
   * 1. Velocity anomaly (< 15 seconds between dispenses) -> +35
   * 2. High-frequency burst anomaly (> 4 dispenses / minute) -> +30
   * 3. Off-hours night operation (22:00 - 06:00 local) -> +40
   * 4. Monotonic counter sequence gap (> 5 skips) -> +25
   * 5. Volumetric single-dispense spike (> 25 kg) -> +20
   */
  public evaluate(context: DispenseAuditContext): EdgeGuardianAssessment {
    if (!context || typeof context !== 'object') {
      return {
        riskScore: 100,
        riskLevel: 'CRITICAL',
        flags: ['INVALID_CONTEXT'],
        recommendedAction: 'BLOCK',
        assessedAt: new Date().toISOString(),
      };
    }

    let score = 0;
    const flags: string[] = [];

    const quantity = safeNumber(context.quantity);
    if (quantity === undefined || quantity < 0) {
      score += 50;
      flags.push(`INVALID_QUANTITY (${String(context.quantity)})`);
    }

    const now = safeIsoDate(context.dispensedAt) ?? new Date();

    if (context.previousDispenseTime) {
      const prevTime = safeIsoDate(context.previousDispenseTime);
      if (prevTime) {
        const diffSeconds = (now.getTime() - prevTime.getTime()) / 1000;
        if (diffSeconds >= 0 && diffSeconds < 15) {
          score += 35;
          flags.push(`VELOCITY_VIOLATION (${diffSeconds.toFixed(1)}s < 15s threshold)`);
        }
      }
    }

    const recentDispenses = safeNumber(context.recentDispensesLastMinute);
    if (recentDispenses !== undefined && recentDispenses > 4) {
      score += 30;
      flags.push(`BURST_VELOCITY_SPIKE (${recentDispenses} dispenses/min > 4)`);
    }

    const hour = now.getHours();
    if (hour >= 22 || hour < 6) {
      score += 40;
      flags.push(`OFF_HOURS_DISPENSE (Operation at ${hour.toString().padStart(2, '0')}:00 hrs)`);
    }

    const expectedCounter = safeNumber(context.expectedCounter);
    const actualCounter = safeNumber(context.actualCounter);
    if (expectedCounter !== undefined && actualCounter !== undefined && actualCounter > expectedCounter + 5) {
      const gap = actualCounter - expectedCounter;
      score += 25;
      flags.push(`COUNTER_GAP_DETECTED (Skipped ${gap} transactions)`);
    }

    if (quantity !== undefined) {
      if (quantity <= 0) {
        score += 50;
        flags.push(`INVALID_NON_POSITIVE_QUANTITY (${quantity} kg)`);
      } else if (quantity > 25.0) {
        score += 20;
        flags.push(`HIGH_VOLUMETRIC_DISPENSE (${quantity.toFixed(1)} kg > 25 kg)`);
      }
    }

    let riskLevel: RiskLevel = 'LOW';
    let recommendedAction: GuardianAction = 'ALLOW';

    if (score >= 75) {
      riskLevel = 'CRITICAL';
      recommendedAction = 'BLOCK';
    } else if (score >= 50) {
      riskLevel = 'HIGH';
      recommendedAction = 'REQUIRE_SUPERVISOR_PIN';
    } else if (score >= 25) {
      riskLevel = 'MEDIUM';
      recommendedAction = 'FLAG_FOR_AUDIT';
    } else {
      riskLevel = 'LOW';
      recommendedAction = 'ALLOW';
    }

    return {
      riskScore: Math.min(score, 100),
      riskLevel,
      flags,
      recommendedAction,
      assessedAt: now.toISOString(),
    };
  }

  /**
   * Batch-audits a stream of transactions to compute aggregate node anomaly metrics.
   */
  public batchAudit(transactions: DispenseAuditContext[]): {
    totalAudited: number;
    blockedCount: number;
    flaggedCount: number;
    supervisorRequiredCount: number;
    averageRiskScore: number;
    assessments: Array<DispenseAuditContext & { assessment: EdgeGuardianAssessment }>;
  } {
    let totalScore = 0;
    let blockedCount = 0;
    let flaggedCount = 0;
    let supervisorRequiredCount = 0;

    const assessments = transactions.map((t) => {
      const assessment = this.evaluate(t);
      totalScore += assessment.riskScore;
      if (assessment.recommendedAction === 'BLOCK') blockedCount++;
      if (assessment.recommendedAction === 'FLAG_FOR_AUDIT') flaggedCount++;
      if (assessment.recommendedAction === 'REQUIRE_SUPERVISOR_PIN') supervisorRequiredCount++;
      return { ...t, assessment };
    });

    return {
      totalAudited: transactions.length,
      blockedCount,
      flaggedCount,
      supervisorRequiredCount,
      averageRiskScore: transactions.length > 0 ? Number((totalScore / transactions.length).toFixed(2)) : 0,
      assessments,
    };
  }
}

