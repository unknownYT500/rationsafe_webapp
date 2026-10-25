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
    let score = 0;
    const flags: string[] = [];

    const now = context.dispensedAt ? new Date(context.dispensedAt) : new Date();

    // 1. Velocity Anomaly Heuristic
    if (context.previousDispenseTime) {
      const prevTime = new Date(context.previousDispenseTime).getTime();
      const currTime = now.getTime();
      const diffSeconds = (currTime - prevTime) / 1000;
      if (diffSeconds >= 0 && diffSeconds < 15) {
        score += 35;
        flags.push(`VELOCITY_VIOLATION (${diffSeconds.toFixed(1)}s < 15s threshold)`);
      }
    }

    // 2. High-frequency Burst Anomaly Heuristic
    if (context.recentDispensesLastMinute !== undefined && context.recentDispensesLastMinute > 4) {
      score += 30;
      flags.push(`BURST_VELOCITY_SPIKE (${context.recentDispensesLastMinute} dispenses/min > 4)`);
    }

    // 3. Off-hours Operation Heuristic (22:00 to 06:00)
    const hour = now.getHours();
    if (hour >= 22 || hour < 6) {
      score += 40;
      flags.push(`OFF_HOURS_DISPENSE (Operation at ${hour.toString().padStart(2, '0')}:00 hrs)`);
    }

    // 4. Counter Discontinuity / Sequence Gap Heuristic
    if (
      context.actualCounter !== undefined &&
      context.expectedCounter !== undefined &&
      context.actualCounter > context.expectedCounter + 5
    ) {
      const gap = context.actualCounter - context.expectedCounter;
      score += 25;
      flags.push(`COUNTER_GAP_DETECTED (Skipped ${gap} transactions)`);
    }

    // 5. Volumetric Anomaly Heuristic
    if (context.quantity <= 0) {
      score += 50;
      flags.push(`INVALID_NON_POSITIVE_QUANTITY (${context.quantity} kg)`);
    } else if (context.quantity > 25.0) {
      score += 20;
      flags.push(`HIGH_VOLUMETRIC_DISPENSE (${context.quantity.toFixed(1)} kg > 25 kg)`);
    }

    // Determine Risk Classification & Action
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
