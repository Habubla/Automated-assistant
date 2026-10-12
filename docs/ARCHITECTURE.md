# June memory architecture

OpenClaw and its native memory remain independent. Gemini remains the configured conversational model. This engine is an optional local service; its absence must not prevent a conversation.

## Trust

Ollama qwen3.5:4b is a bounded proposal generator. ALL model candidates, including direct-statement classifications, are pending observations with suggested active metadata. A genuine source quote does not prove a generated claim. Only an explicit human review can confirm, correct or reject a candidate. A separate reviewer credential is required over HTTP. The worker has no review or active-write authority.

Evidence resolves to an immutable redacted archive, an exact user quote and the exact captured timestamp. Review preserves the original claim and the correction separately. Confidence is informational. Profile promotion copies a supported confirmed claim exactly. Contradictory or superseded support suppresses the profile on retrieval. Summaries are untrusted source-linked context and never returned as facts.

## Storage and recovery

Canonical storage remains JSON under records/ and archives/. Node 24's built-in SQLite is used only to coordinate writers in .june-memory-lock.sqlite. BEGIN IMMEDIATE serializes cooperating processes; OS cleanup releases a dead process's lock. A legacy directory lock is refused until its owner has been checked. No age-based lock stealing.

Each mutation first writes an immutable, checksummed revision intent to audit/, then replaces the current JSON record atomically. The current record is the commit point. Orphan intents from interrupted writes are preserved but never read as current facts. Restart and retry leave old records intact. Hard-link exclusive creation prevents accidental overwrites; writes flush content before publish and remove temporary files on failure. Atomic publish assumes a local filesystem supporting atomic rename and hard links (NTFS here). This is process-crash protection, not a guarantee against every hardware/power failure.

Active updates use expectedRevision to reject conflicting changes. Archive content and session IDs are immutable. Pipeline receipts make successful retries idempotent, and deterministic candidate IDs make interrupted retries deduplicate. A summary failure is reported separately and does not turn a candidate into fact. Historical notes are never rewritten or imported implicitly.

## Retrieval

Targeted Unicode keyword search returns supported current records with archive references, exact quotes and timestamps. Completed, cancelled, paused, superseded and expired records are excluded. A missed deadline remains actionable and is explicitly labeled overdue; dueAt is not an expiration. Activated candidates cannot reappear as active facts after their task completes. This is deterministic lexical search, not semantic embeddings.

## Operational boundaries

Native OpenClaw memory-core/local indexing remains unchanged. Its Markdown extraPaths do not enforce this engine's trust rules; do not export pending candidates there. Integration uses an optional tool plugin and a documented API adapter, not an invented conversation event. No credentials are stored in source or workflow exports. All service URLs are loopback-only. Model requests, responses, timeouts and retries are bounded.
