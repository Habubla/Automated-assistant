# June local n8n workflows

n8n 2.42.6 is installed locally in runtime/; it requires Node >=24.0.0 (host v24.19.0). No global n8n or existing ~/.n8n instance was present at baseline. This dedicated runtime uses its own user directory, SQLite and credentials. No Windows task/service was created.

## Prepared setup

scripts/prepare-local.ps1 has imported two encrypted n8n credentials and all five inactive workflows into runtime/user. It creates private generated credentials through scripts/local-settings.ps1. It does not expose the reviewer credential to n8n. The temporary plaintext credential import file is removed after success.

Start the memory API with ../../scripts/start-memory.ps1, then n8n with ./start-local.ps1, each manually in its own terminal. June's n8n listens on 127.0.0.1:5680; its runner broker binds loopback on 5681. Visit http://127.0.0.1:5680 and complete the local owner-account setup if prompted. No account password was invented. The dedicated port avoids the separate Docker n8n installation on 5678.

## Workflows

| Export | Trigger | Default behavior |
|---|---|---|
| june-candidates.json | Authenticated POST /webhook/june-memory-candidates; manual synthetic fixture | Validate bounded transcript, call Qwen through engine, retain pending candidates, return sanitized result |
| june-consolidation.json | 03:00 daily; manual | Preview yesterday's local daily note; set dryRun=false after reviewing eligible source |
| june-reminders.json | Hourly; manual | 24-hour lead time, dry run; set dryRun=false for deduplicated local outbox delivery |
| june-health.json | Every 15 minutes; manual | Check Gateway/Ollama/n8n/engine, persist meaningful state changes; never restart |
| june-backup.json | 04:00 daily; manual | Engine-managed vault/source/config/SQLite backup, hash/integrity verification, no retention deletion |

Timezone: Asia/Calcutta. Edit the Schedule Trigger to change timing. Workflows remain inactive until deliberately published. The manual intake fixture creates a synthetic pending record in whichever vault the target engine uses; run it only against a test vault if you do not want test data in canonical memory.

Inbound credential: Header Auth named June inbound webhook; header X-June-Webhook-Key. API credential: Header Auth named June Memory worker (local); Authorization: Bearer plus the worker secret. Neither value is exported in workflow JSON. URLs default to http://127.0.0.1:3210 and can be edited per HTTP node.

The workflow intentionally delegates extraction, model-output validation, evidence checking and persistence to the engine. n8n cannot confirm or activate memories. Do not add a direct Ollama-to-vault write node.

## Input and failure behavior

POST body:
```json
{"sessionId":"stable-source-id","messages":[{"role":"user","content":"A bounded statement.","timestamp":"2026-10-12T09:00:00+05:30"}]}
```

Wrong webhook credentials are rejected before processing. Invalid shape returns 400. The engine independently enforces strict timestamps, source grounding, field limits and safe IDs. Same ID/same content replays safely; same ID/different content conflicts. Engine failure takes a sanitized failure route and returns 503. Retry the original source ID, never invent a fresh one to work around a failure.

Success/error execution data and manual execution persistence are disabled in exports. Reports contain counts/status, not transcripts or raw exception bodies. The engine stores review reports and reminder state locally. The health job writes only when check results change; no external notifications are sent.

Reminder delivery means a durable local-outbox record under state/notifications. External mail/chat/push is deliberately not wired; a destination and credentials require explicit configuration and authorization first.

Daily notes are read from daily/YYYY/MM/YYYY-MM-DD.md. Initial dry runs preserve original bytes. Applying creates a redacted source archive and pending candidates with a report linking the source path/hash; it does not rewrite the original note or promote historical claims.

## Reproduce verification

```powershell
cd D:\June\JuneMemory
node scripts/n8n-smoke.js
node scripts/n8n-webhook-smoke.js
```

The first script imports and executes all five workflows in an isolated n8n profile against a fake worker and disposable vault. The second tests nonempty daily material, reminder dry runs/local delivery/replay, real webhook authentication, malformed requests, idempotency and engine outage. It temporarily publishes only the synthetic webhook, starts a loopback n8n process, and stops its owned process tree afterward. Production workflow activation is unaffected.

Results: docs/N8N_VERIFICATION.json and docs/N8N_WEBHOOK_VERIFICATION.json. Raw synthetic diagnostics stay in ignored .local/ directories. Initial database migration exceeded the first 120-second harness allowance; after diagnosing migration progress, a 300-second initial allowance completed. n8n's missing-Python-runner warning does not prevent these JavaScript workflows from running.

For a fresh install:
```powershell
cd D:\June\JuneMemory\automation\n8n\runtime
npm install n8n@2.42.6 --no-audit --no-fund
& D:\June\JuneMemory\scripts\prepare-local.ps1
```
Inspect existing runtime state before reimporting edited workflows. Preserve runtime/user and .local/service-secrets.json together when backing up n8n itself; the vault/OpenClaw backup job does not back up n8n's credential database.

References: https://docs.n8n.io/hosting/installation/npm/ and https://docs.n8n.io/hosting/cli-commands/
