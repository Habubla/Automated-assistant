# Upstream audit and deferred voice adapter

Inspected 2026-10-12. Existing reference repositories were not changed or updated.
- fullstack-agent checkout 5bb159f, clean: https://github.com/jaredrhod/fullstack-agent
- ai-memory-vault checkout 659bba9, clean: https://github.com/jaredrhod/ai-memory-vault
  URL was found in fullstack-agent README lines 21–24 and verified with the checkout's Git remote.
- Backtalk: https://github.com/jaredrhod/backtalk
- Optional future integrations linked by fullstack-agent: https://github.com/jaredrhod/ai-visualizer and https://github.com/jaredrhod/barehands

The fullstack installer is a Claude Code wizard and shell/batch launcher/updater. Its adopt-existing-folder pattern and configuration-based boundaries are useful; running that installer would introduce unrelated runtime assumptions. The vault repository supplies Markdown conventions, daily notes, profile/index pointers and job instructions. It does not provide this engine's executable schemas, provenance checks or trust enforcement. June uses original code and worksheets; no upstream implementation/template was copied.

## Licenses inspected

Local fullstack-agent LICENSE: AGPL-3.0; local ai-memory-vault LICENSE: CC BY-SA 4.0.
Remote Backtalk, ai-visualizer and barehands LICENSE files: AGPL-3.0. Their notices and repository descriptions identify AGPL-3.0-or-later.
These are separate licenses, not a blanket permissive license. References remain separate; any later adaptation must retain the relevant attribution/license terms. No redistribution or claim of cross-license compatibility is made here.

Sources: [fullstack](https://github.com/jaredrhod/fullstack-agent/blob/main/LICENSE), [vault](https://github.com/jaredrhod/ai-memory-vault/blob/main/LICENSE), [Backtalk](https://github.com/jaredrhod/backtalk/blob/main/LICENSE), [visualizer](https://github.com/jaredrhod/ai-visualizer/blob/main/LICENSE), [barehands](https://github.com/jaredrhod/barehands/blob/main/LICENSE).

## Backtalk boundary

[pyproject.toml](https://github.com/jaredrhod/backtalk/blob/main/pyproject.toml) requires Python >=3.11,<3.13. Dependencies include Claude Agent SDK, faster-whisper, httpx and Kokoro; a generic Python command alone is not proof of compatibility.

[brain.py](https://github.com/jaredrhod/backtalk/blob/main/backtalk/brain.py) imports ClaudeSDKClient/ClaudeAgentOptions and implements WarmBrain.start(), ask_stream(utterance), interrupt(), reset_turn(), stop(), plus Claude-specific console/usage calls. ask_stream yields complete sentences. Its session/interrupt behavior is coupled to the Claude stream.

[ears.py](https://github.com/jaredrhod/backtalk/blob/main/backtalk/ears.py) supplies local microphone capture, voice detection and Whisper transcription. [mouth.py](https://github.com/jaredrhod/backtalk/blob/main/backtalk/mouth.py) supplies Mouth.say(), say_chunk(), shut_up(), wait_done(), shutdown(); Kokoro is the local TTS path. External voice providers are optional and unnecessary for June.

## Smallest future adapter (not implemented or started)

PTT/audio capture -> local STT text -> OpenClawBrain.ask_stream(text) -> sentence chunks -> Mouth.say_chunk(). Replace only the brain boundary. A separate adapter package must not import claude_agent_sdk; packaging must also remove that mandatory dependency from the selected runtime path.

First version can wrap the supported OpenClaw CLI already represented by src/adapter.js; output is buffered, so it will not have upstream streaming latency. After approved Gateway endpoint enablement, a loopback HTTP streaming adapter can use /v1/chat/completions with model openclaw/main and a stable voice-session key. The installed endpoint is currently disabled. Do not turn it on implicitly.

start checks availability; ask_stream uses a bounded request and never blocks on memory; interrupt cancels the current operation and speech queue; reset_turn never replays a stale response; stop closes only adapter-owned resources. Map approvals deliberately: a Backtalk spoken yes must not automatically grant OpenClaw operator/tool permissions or memory-review authority.

Acceptance before full voice: live Gateway conversation with memory on/off; interruption and no stale reply; no duplicate memory submission; local microphone/STT/TTS checks; provider outage speech; license review if modifying upstream. ai-visualizer can consume the existing state signal boundary later. barehands remains an independent optional webcam/UI project. No voice installation, microphone activation or unattended startup was performed.
