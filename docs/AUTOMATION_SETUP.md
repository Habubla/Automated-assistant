# Local setup template

Install the project dependencies, Ollama, OpenClaw and a compatible n8n runtime. Copy the fictional Settings examples into a private data directory and configure the paths in the launchers. Generate private service tokens with scripts/local-settings.ps1; install n8n credentials privately.

The tracked workflow exports contain credential references, not credential values. Activate schedules only after configuring local authentication. Windows tasks and desktop shortcuts must be registered locally by the operator.

Never publish Settings, .local, runtime profiles, backups or your memory vault.
