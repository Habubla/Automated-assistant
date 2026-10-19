# Desktop startup template

Review the data paths in scripts/local-settings.ps1 and scripts/gateway-environment.ps1. Install optional runtimes privately. Start-June.vbs starts the stack; Stop-June.vbs stops services whose ownership is verified. Messages-June.vbs, Mail-June.vbs and Tasks-June.vbs open their views.

Create shortcuts and a Windows logon task locally if desired. Startup-June.vbs is the hidden logon entry point. The public repository does not register tasks or shortcut keys by itself. The task widget uses Windows PowerShell/WPF and local Hub authentication.

June n8n uses 5680 and its runner broker uses 5681 by default. Keep any separate installation on 5678 independent. Startup can take several minutes; service readiness and recovery depend on the configured runtimes.
