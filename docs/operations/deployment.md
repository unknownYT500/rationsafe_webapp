<!-- file: deployment.md -->
# Infrastructure & Release Engineering

## 1. Environments
- **Local**: `docker-compose up`. MySQL, API, Web, Worker.
- **Staging**: Mirrors prod, seeded with synthetic data.
- **Production**: K8s cluster.

## 2. Production Topology
- **Ingress**: NGINX/Traefik with TLS termination.
- **API**: 3+ replicas. HPA based on CPU/Request rate.
- **DB**: AWS RDS / Cloud SQL. Multi-AZ. Automated daily backups.
- **Nodes**: Physical devices or edge VMs. Connected via mTLS.

## 3. Secret Management
- HashiCorp Vault or AWS Secrets Manager.
- DB credentials, JWT secrets, and Edge Node private keys injected at runtime.
- Zero secrets in git.

## 4. Rollout Strategy
- **API**: Rolling update. Health checks gate progression.
- **DB**: Migrations run via CI/CD pipeline before API rollout. Backward compatible only.
- **Nodes**: Over-the-air (OTA) updates for node software.