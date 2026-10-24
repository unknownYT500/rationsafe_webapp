<!-- file: acceptance-criteria.md -->
# Release Gates

## Production Readiness Checklist
- [ ] All 5 transaction states implemented and tested.
- [ ] Ed25519 token signing/verification passes test vectors.
- [ ] Offline node survives simulated power loss without data corruption.
- [ ] Quota lease enforcement prevents double-spending across disconnected nodes.
- [ ] Sync is 100% idempotent (verified by duplicate batch tests).
- [ ] No PII in logs or tokens.
- [ ] RBAC enforced on 100% of sensitive endpoints.
- [ ] Security simulation environment isolated from prod.
- [ ] Database backup restoration tested and documented.
- [ ] All critical runbooks reviewed by ops team.
- [ ] Sign-off from Product, Security, and Engineering leads.