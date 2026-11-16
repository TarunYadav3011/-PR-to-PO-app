# Corvo Procurement Workbench

A starter implementation of the Cantill.ai PR-to-PO task: chat intake, a versioned policy store, buyer workspace, batch API/export and audit trail.

## Run locally
```bash
docker compose up --build
```
Open http://localhost:3000. Without Docker:
```bash
npm install
npm start
```

## Important source-kit limitation
The supplied files in this workspace were `Cantill_FullStack_Task_Brief.pdf` and `Worked_Examples.pdf`. The brief also lists `Corvo_Procurement_Policy.pdf`, `master_data/`, `contracts/`, and `pr_batches/sample_pr_batch.csv`, but those were not included in the uploads available here. Therefore `policy-v5-extracted.json` is explicitly a **partial extraction from worked examples**, not a complete or production-safe implementation of Policy v5.0.

Do not use the starter's sample decision outcomes as authoritative procurement decisions until the complete policy and source data are loaded and the engine has been completed and tested. In particular, contract precedence/ceilings, signed-PDF-only contracts, full valuation, item matching, clubbing, PO consolidation, and preferred supplier scoring need the missing source files.

## Policy data
The engine reads ordered `rules[]` from the active policy record in SQLite. A new JSON policy is uploaded, previewed, and approved from Policy management. The policy version is stored independently from application logic. JSON format:
```json
{
  "version": "5.1",
  "effectiveFrom": "2026-11-20",
  "rules": [
    {"id":"RULE_ID","priority":10,"when":{"plant":"CHK1","valueLt":200000},"then":{"decision":"PO","route":"SPOT_PO","supplierCount":1},"explanation":"Business-readable rationale"}
  ]
}
```
A policy PDF cannot safely be treated as executable policy without extraction, schema validation, a change preview and human approval. Production implementation should add a reviewed PDF-to-policy extraction pipeline.

## API
- `POST /api/chat` — create a request from chat fields/message; asks for missing plant, quantity and need-by date.
- `GET /api/dashboard` — counts and recent requests.
- `GET /api/policy` — policy versions.
- `POST /api/policy/upload` — upload a structured JSON policy draft.
- `POST /api/policy/:id/approve` — approve a policy version.
- `POST /api/process-batch` — multipart CSV upload, returns decision CSV.
- `POST /api/requests/:id/approve` — buyer approval.
- `POST /api/requests/:id/override` — requires a comment.
- `GET /api/audit` — audit history.

## Current implementation boundaries
- The UI and backend are functional starter code, not the completed scored solution.
- The chat intake is deliberately conservative and requires explicit plant, quantity and need-by date; robust item disambiguation and confirmation turns remain to implement.
- Supplier ranking is a basic history-count/recency/rating ordering, not the final explainable scoring model.
- Batch endpoint currently provides a first-pass line-level decision export; full clubbing and PO consolidation are not yet implemented.
- Approve records the buyer action; integration to ERP/actual PO or RFQ document generation is not included.
- Add authentication/role-based access, validation, tests, production database migrations, hosting and monitoring before deployment.
