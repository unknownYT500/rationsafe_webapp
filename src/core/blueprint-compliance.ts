// src/core/blueprint-compliance.ts
/**
 * Blueprint Statutory Policy & Regulatory Compliance Engine (TypeScript)
 * 
 * Implements National Food Security Act (NFSA 2013) statutory rules, entitlement caps,
 * and zero-leakage PII cryptographic masking for central and edge nodes.
 */

import crypto from 'node:crypto';

export type CardCategory = 'PHH' | 'AAY' | 'AY' | 'GEN';

export interface BlueprintComplianceResult {
  isCompliant: boolean;
  maxPermissibleQuota: number;
  remainingQuota: number;
  violationReason?: string;
  piiMaskedCardId: string;
}

export interface BeneficiaryPolicyProfile {
  cardId: string;
  category: CardCategory;
  familyCount: number;
  monthlyQuotaConsumed: number;
  aadhaarNumber?: string;
}

export class BlueprintComplianceEngine {
  /**
   * National Food Security Act (NFSA 2013) Statutory Rules:
   * 1. PHH (Priority Household): 5.0 kg per family member per month
   * 2. AAY (Antyodaya Anna Yojana): 35.0 kg fixed per household per month
   * 3. AY (Annapurna): 10.0 kg fixed per senior citizen per month
   * 4. GEN (General State / APL): 15.0 kg default baseline
   */
  public static calculateStatutoryEntitlement(category: CardCategory, familyCount: number): number {
    const validMembers = familyCount > 0 ? familyCount : 1;
    switch (category) {
      case 'PHH':
        return validMembers * 5.0;
      case 'AAY':
        return 35.0;
      case 'AY':
        return 10.0;
      case 'GEN':
        return 15.0;
      default:
        return 15.0;
    }
  }

  /**
   * Validates a proposed dispense against NFSA statutory entitlement caps.
   */
  public static validateDispense(
    profile: BeneficiaryPolicyProfile,
    requestedQuantity: number
  ): BlueprintComplianceResult {
    const piiMasked = this.maskIdentifier(profile.cardId);

    if (requestedQuantity <= 0) {
      return {
        isCompliant: false,
        maxPermissibleQuota: 0,
        remainingQuota: 0,
        violationReason: 'Requested quantity must be strictly greater than zero.',
        piiMaskedCardId: piiMasked,
      };
    }

    const statutoryCap = this.calculateStatutoryEntitlement(profile.category, profile.familyCount);
    const availableQuota = Math.max(0, statutoryCap - profile.monthlyQuotaConsumed);

    if (requestedQuantity > availableQuota) {
      return {
        isCompliant: false,
        maxPermissibleQuota: statutoryCap,
        remainingQuota: availableQuota,
        violationReason: `Statutory NFSA cap exceeded: requested ${requestedQuantity.toFixed(2)} kg, remaining balance is ${availableQuota.toFixed(2)} kg (Monthly limit: ${statutoryCap.toFixed(2)} kg).`,
        piiMaskedCardId: piiMasked,
      };
    }

    // Single-transaction safety ceiling
    if (requestedQuantity > 35.0) {
      return {
        isCompliant: false,
        maxPermissibleQuota: statutoryCap,
        remainingQuota: availableQuota,
        violationReason: `Single dispense exceeds regulatory safety ceiling (35.0 kg max per transaction).`,
        piiMaskedCardId: piiMasked,
      };
    }

    return {
      isCompliant: true,
      maxPermissibleQuota: statutoryCap,
      remainingQuota: Number((availableQuota - requestedQuantity).toFixed(2)),
      piiMaskedCardId: piiMasked,
    };
  }

  /**
   * Irreversible cryptographic identifier pseudonymization using SHA-256
   */
  public static maskIdentifier(plainCardId: string): string {
    const hash = crypto.createHash('sha256').update(plainCardId.trim()).digest('hex');
    return hash.slice(0, 16);
  }

  /**
   * Masks a 12-digit Aadhaar number into standard compliant masked format: XXXX-XXXX-1234
   */
  public static maskAadhaar(aadhaar: string): string {
    const clean = aadhaar.replace(/\D/g, '');
    if (clean.length < 4) return 'XXXX-XXXX-XXXX';
    const last4 = clean.slice(-4);
    return `XXXX-XXXX-${last4}`;
  }
}
