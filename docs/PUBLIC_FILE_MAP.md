# Private files and public dummy counterparts

| Private local file or directory | Public counterpart |
|---|---|
| Settings/email-accounts.json | examples/Settings/email-accounts.json |
| Settings/gemini-api-keys.txt | examples/Settings/gemini-api-keys.txt |
| Settings/whatsapp-priority.txt | examples/Settings/whatsapp-priority.txt |
| Settings/whatsapp-ignore.txt | examples/Settings/whatsapp-ignore.txt |
| Settings/opportunities.json | examples/Settings/opportunities.json |
| .local/service-secrets.json | examples/runtime/service-secrets.example.json |
| .local/hub/access.json | examples/runtime/hub/access.example.json |
| .local/hub/hub.sqlite | examples/runtime/hub/hub.example.sqlite |
| .local/hub/whatsapp/creds.json and device key files | examples/runtime/hub/whatsapp/creds.example.json |
| .local/gemini-pending/*.json | examples/runtime/gemini-pending/request.example.json |
| OpenClaw configuration and provider credentials | examples/OpenClaw/*.example.json |
| OpenClaw agent transcript database | examples/OpenClaw/openclaw-agent.example.sqlite |
| MemoryVault personal profile and deadlines | examples/MemoryVault/*.example.* |
| Research personal briefs | examples/Research/brief.example.md |
| automation/n8n/runtime/user/.n8n/database.sqlite | examples/n8n/database.example.sqlite |
| Machine deployment and verification reports | docs/examples/*.example.json |
| Backups, RestoreTests and original Git metadata | Excluded entirely |

The three example SQLite files contain only fictional or empty data. WhatsApp's numerous device keys are represented by a single explanatory example rather than copies of private filenames or keys. Actual contents and personal filename inventories were not exported.

## New runtime examples

| Private state | Fictional counterpart |
|---|---|
| Hub tasks table | examples/runtime/hub/tasks.example.json |
| Hub task_notifications table | examples/runtime/hub/task-notifications.example.json |
| Hub summaries table | examples/runtime/hub/summaries.example.json |
| Hub opportunities table and scan state | examples/runtime/hub/opportunities.example.json |
| Hub Gemini failed/pending requests | examples/runtime/hub/gemini-requests/request.example.json |
| .local/runtime/widget-status.json | examples/runtime/widget-status.example.json |
| Workflow and audit PDFs | Excluded |

The table examples contain invented values; none were derived from message contents, deadlines, account identifiers or real research history.
