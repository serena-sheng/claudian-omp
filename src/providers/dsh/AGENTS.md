# DeepSeek Harness (dsh) constraints

dsh-specific facts (this provider was ported from the Grok skeleton; these are the verified differences):

- The CLI is `dsh` (npm package `@deepseek-ai/dsh`, developer preview). It requires Node.js. ACP mode is `dsh --profile acp` (ACP v1, `protocolVersion: 1` over stdio).
- Authentication is environmental: `DEEPSEEK_API_KEY` (optional `DEEPSEEK_BASE_URL`). `initialize` returns `authMethods: []` — never call ACP `authenticate`. Users without a key only fail at `session/prompt` time (`no API key for provider route ...`); catalog discovery must not require a key.
- Session resume: dsh does NOT implement `session/load` (Method not found). It implements `session/resume` with the same `{cwd, mcpServers, sessionId}` params. The mapping lives in this provider's `methodNameOverrides: { loadSession: 'session/resume' }` on `ACPClientConnection` — never change the shared `ACP_METHOD_NAMES` defaults for other providers.
- No `session/fork` and no rewind: `supportsFork`/`supportsRewind` are false, so fork/rewind UI must not render. Do not reintroduce xAI-style extension requests (`_x.ai/*`) — dsh has no extension methods.
- Model catalog: parsed from the `session/new` response `configOptions` — a `select` with `category: "model"`, possibly GROUPED options (group = provider route, e.g. `deepseek-official`). Option values are JSON-encoded `["route","model"]` strings (e.g. `"[\"deepseek-official\",\"deepseek-v4-flash\"]"`) and must round-trip verbatim: they are sent back unchanged as `session/set_config_option` values. Encoded selection ids use the `dsh:` prefix.
- Model switching on a live session is `session/set_config_option` `{sessionId, configId: "model", value}`; dsh does NOT implement `session/set_model`.
- Native sessions live under `$DSH_HOME` (default `~/.dsh`): transcripts are zstd-compressed v4 JSONL at `$DSH_HOME/sessions/<cwd-encoded>/<sessionId>/session.v4.jsonl.zstd` plus a `storages/session_projcache` JSON projection. The event schema is undocumented, so Claudian does NOT read native history (`supportsNativeHistory: false`); resume relies on `session/resume` with the persisted session id only. `DSH_HOME` and all `DEEPSEEK_*`/`DSH_*` variables belong to this provider's environment scope (`environmentKeyPatterns`).
- Turn steering/interjection used Grok `_meta` hooks; dsh has no documented equivalent, so `supportsTurnSteer` is false.
- dsh publishes no reasoning-effort metadata; `reasoningControl: 'none'` and reasoning helpers must return empty lists — never fabricate effort choices.
- `session/cancel` is a notification (no id). `session/close {sessionId}` ends a session; the discovery probe closes its discovery session best-effort.
