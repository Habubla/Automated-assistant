# June

June is a local personal-assistant project with separate WhatsApp and email viewers, a memory review service, local Qwen summaries and sorting, an optional OpenClaw integration, and n8n workflow templates.

This public copy contains source code, tests, workflow templates and fictional example settings. Personal messages, mailboxes, contact lists, credentials, linked-device state, backups, research history and original Git history are excluded.

## Requirements and source checks

Node.js 24+, npm, Windows PowerShell for desktop launchers, and optional Ollama/OpenClaw/n8n runtimes.

```powershell
npm ci --ignore-scripts
npm test
```

Install and configure optional runtimes separately before using the desktop launchers. The Windows service scripts use D:/June data-directory defaults; review those paths for your own installation. No startup tasks or desktop shortcuts are registered by cloning this repository. Tests use isolated synthetic fixtures.

Qwen 3.5 4B supplies local summaries, email categories and pending memory candidates. Human confirmation is required before candidates become trusted deadlines or profile facts. The mail collector is read-only. WhatsApp media is labelled without downloading its contents; the viewer displays collected messages rather than full historical account sync.

## Dummy counterparts for private files

The [example-file map](docs/PUBLIC_FILE_MAP.md) lists each private file and its safe counterpart. Settings examples retain the original basenames inside examples/Settings. Runtime, provider and vault examples use .example names.

Copy examples to private local paths before entering real account details. The published mailbox addresses use the reserved example.test domain, accounts are disabled, API-key files contain comments only, and tokens are blank. Never fill in real values inside the tracked examples.

Use the private dashboard for mailbox authorization and WhatsApp pairing. Generated databases, account credentials and device keys must remain outside Git.

## Project layout

- src/: memory service, storage, inbox collectors and local model adapter.
- ui/: dashboard, WhatsApp conversations and filtered mail views.
- integrations/openclaw/: optional local memory plugin.
- automation/n8n/: workflow generators and templates.
- scripts/: Windows launchers and synthetic checks.
- test/: automated tests.
- examples/: fictional configuration and private-file counterparts.

[Architecture](docs/ARCHITECTURE.md) describes the trust and storage model. [Upstream references](docs/UPSTREAM_AND_VOICE.md) records external project attribution and separate license boundaries.

## Publishing and maintaining privacy

This folder has fresh Git history using the repository owner's contribution identity and no configured remote. Publish this copy rather than the working installation.

Before every later publication, review staged files and run npm run audit:public. The audit rejects sensitive runtime paths, actual key-shaped strings, enabled example accounts, nonblank example credentials, non-example email addresses and example files replaced with real data.

The publication bundle intentionally does not include generated deployment evidence from a personal machine. Examples under docs/examples are dummy report shapes, not claimed runtime verification results.
