<!-- file: token-protocol.md -->
# Provisional Token & Cryptographic Protocol

## 1. Token Format (Canonical JSON)
```json
{
  "v": 1,
  "tid": "txn_uuid",
  "nid": "node_uuid",
  "lid": "lot_uuid",
  "gid": "grant_uuid",
  "qid": "quota_res_uuid",
  "sub": "sha256_hash_of_card_id",
  "n": "unique_nonce",
  "c": 1042,
  "qty": 5.50,
  "unit": "kg",
  "iat": 1690000000,
  "exp": 1690003600,
  "kid": "key_uuid"
}