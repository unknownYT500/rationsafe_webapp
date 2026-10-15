<!-- file: assumptions.md -->
# Assumptions & Unresolved Decisions

| ID | Assumption | Impact | Risk | Status |
|---|---|---|---|---|
| ASM-01 | `number` field in registration is normalized to `phone_number`. No govt ID collected. | Simplifies PII handling. | May miss business need for ID verification. | **Approved Default** |
| ASM-02 | Grain distribution unit is kilograms (kg). | Standardizes quantity math. | Business may prefer liters or bags. | **Pending Approval** |
| ASM-03 | Offline nodes can operate for 72 hours before mandatory sync. | Defines outbox storage sizing. | Nodes offline longer will halt distribution. | **Approved Default** |
| ASM-04 | Quota leases are allocated daily. | Prevents real-time sync need. | Inefficient if traffic is highly localized. | **Pending Approval** |
| ASM-05 | Personal ID recovery requires OTP to registered phone. | Secure, no password needed. | SIM swap attacks possible. | **Approved Default** |