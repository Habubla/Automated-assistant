# Inbox, tasks and opportunities

## Unread summaries

Unread state is local to June. A fresh installation starts from the current day in IST; its saved baseline survives restarts. June does not synchronize phone read state or send read receipts. Summaries snapshot all selected incoming unread messages and run in bounded local-model batches. The collector's stored-text bound still applies; attachment contents are not interpreted. Completed batches are retained on failure. The same selection resumes its job, while a changed selection can start a separate job. Marking summarized messages read is an explicit action.

## Tasks and reminders

Incoming mail and WhatsApp text can produce detected tasks. Date interpretation is heuristic and uses the original message time. Date-only deadlines use 23:59 IST and carry a warning; missing dates remain undated. Source-based briefs retain the request, date quote, links and attachment labels. Review applicability and dates before relying on a task. Task-board state is separate from confirmed JuneMemory records.

The task board supports confirmation, due-date edits, completion, dismissal, mute, snooze and manual reminders. Reminder stages are 24 hours, 1 hour and when due, with catch-up after downtime. Windows notification settings can suppress banners. Closing the widget hides it in the tray; its menu can exit it.

## Desktop setup

Configure private paths and optional runtimes before launching. Tasks-June.vbs opens the task board; start-widget.ps1 launches the WPF widget. Desktop shortcuts and a Windows logon task must be registered locally. Native n8n defaults to ports 5680/5681 to avoid a separate installation on 5678. Review ports for your machine.

## Gemini and research

The Settings key-pool example is blank. Enter credentials only in private settings. The pool rereads settings, retains failed request snapshots and applies bounded retries. Keys in the same Google project share quota. Native Gateway/provider behavior depends on the installed OpenClaw version; changing a file is not proof that every native authentication cache has refreshed.

Public scans target 09:00 and 18:00 IST, with catch-up while June runs. The restricted research-agent route and Google Search grounding fallback prepare leads. A fetched page does not prove every claim, fee or deadline. LinkedIn email alerts can be collected from authorized mailboxes; direct account-feed/event access and application submission are not connected. No real account, provider request or deployment is verified by this public export.

## Fictional state examples

See examples/runtime/hub for task, reminder, summary, opportunity and Gemini-request shapes, and examples/runtime/widget-status.example.json for widget status. These examples are documentation, not files to load over your database.
