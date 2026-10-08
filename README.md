# Claudian OMP

An independent fork of [Claudian](https://github.com/YishenTu/claudian) by Yishen Tu.
It keeps everything Claudian already does — chat tabs, inline editing, session manager,
Zen mode, dual pane, side chat, agent skills, turn steering, subagent history — and adds
extra agent harnesses plus a few enhancements borrowed from
[oh-my-claudian](https://github.com/lee259/oh-my-claudian) by Lee.

Both upstream projects are MIT licensed; see NOTICE.md and LICENSE.

## Requirements

- Obsidian v1.13.0+
- Desktop only (macOS, Linux, Windows)
- At least one agent CLI installed locally, plus whatever subscription or API access that CLI needs

## Supported providers

Each provider is a locally installed agent CLI. The plugin drives it as a subprocess;
nothing is bundled and nothing is downloaded for you.

| Provider | CLI | Notes |
|---|---|---|
| Claude Code | `claude` | `@anthropic-ai/claude-code` |
| Codex CLI | `codex` | `@openai/codex` |
| Grok Build | `grok` | speaks ACP |
| OpenCode | `opencode` | speaks ACP |
| Pi | `pi` | `@earendil-works/pi-coding-agent` |
| **Oh My Pi (OMP)** | `omp` | `@oh-my-pi/pi-coding-agent` — install with the omp.sh install script |
| **DeepSeek Harness** | `dsh` | `@deepseek-ai/dsh` — needs Node.js and a DeepSeek API key |

Providers can also be pointed at other model backends through their own configuration
(for example running Claude Code against a non-Anthropic endpoint), which is covered by
that CLI's own documentation.

## Disclosures

Required by the Obsidian developer policies, and true as of this fork:

- **Network use.** By default the plugin itself makes no network requests. The agent CLIs
  it launches do: they talk to their own model providers (Anthropic, OpenAI, xAI, DeepSeek,
  …) and to any MCP servers you configure. Which services are contacted, and with which
  credentials, is determined by those CLIs and by the environment variables you set in each
  provider's settings.
  There is exactly one optional exception: if you turn on **Check for CLI updates**, the
  plugin queries `https://registry.npmjs.org` (public npm registry, no identifiers sent
  beyond the package names) to tell you when an installed CLI has a newer release. It is
  off by default and can be turned off again at any time.
- **Files outside the vault.** Each agent CLI is started with your vault as its working
  directory, but the CLIs may read and write outside it (their own config, credentials,
  session stores and caches; OMP uses `~/.omp`, Pi uses `~/.pi`, DeepSeek Harness uses
  `~/.dsh`). Session metadata is kept inside the vault under the plugin's own folder.
- **Paid services.** Some providers require a paid subscription or API key. The plugin
  does not sell anything and does not install or update any CLI for you.
- **Desktop only.** `isDesktopOnly` is true: the plugin spawns subprocesses through Node
  APIs and cannot work on mobile.

## Installing

Not in the community directory — this is a fork, and Obsidian's developer policies require
explicit permission from the original author before a fork may be listed there
(https://docs.obsidian.md/community-directory/developer-policies). Until that is sorted
out, install it manually or via BRAT:

1. Download `main.js`, `manifest.json` and `styles.css` from the latest release.
2. Put them in `YOUR_VAULT/.obsidian/plugins/claudian-omp/`.
3. Enable **Claudian OMP** in Settings, Community plugins.

Do not enable this plugin and the upstream **Claudian** at the same time: they would both
register a chat view and would fight over the same storage.

## Building

```sh
npm ci
npm run build      # produces main.js and styles.css in the repository root
```

Requires Node.js 24.x. `npm run test:unit` runs the unit suite; `npm run typecheck` and
`npm run lint` are also wired up.

## Configuration

Settings live in `.claudian-omp/` inside your vault. The plugin stores its settings file,
session metadata and cached catalogs there — separate from upstream Claudian, which uses
`.claudian/`, so the two can coexist on disk without corrupting each other.

## Credits

- [Claudian](https://github.com/YishenTu/claudian) — Yishen Tu (MIT). The architecture,
  the provider framework, the chat UI and most provider implementations are theirs.
- [oh-my-claudian](https://github.com/lee259/oh-my-claudian) — Lee (MIT). Several
  enhancements in this fork were ported from it, and it was the reference for the OMP and
  DeepSeek Harness providers.
