# Attribution

This project is a fork of [Claudian](https://github.com/YishenTu/claudian) by
**Yishen Tu** (MIT licensed). The upstream project provides the plugin
architecture, provider framework, chat UI, and the Claude Code / Codex / Grok /
OpenCode / Pi provider implementations that this fork builds on.

The **OMP (Oh My Pi) provider** in this fork was written for this project by
comparing the shipped `omp` binary against the upstream `pi` provider. The
approach was informed by [oh-my-claudian](https://github.com/lee259/oh-my-claudian)
by **Lee** (also a Claudian fork, MIT licensed), which independently added OMP
support over an ACP transport; only OMP-specific facts (binary name, npm package,
env-var isolation, approval-mode values) were taken from it, not its execution
layer.

Both upstream projects are MIT licensed. See `LICENSE`.

## Modifications in this fork

Copyright (c) 2026 Serena Sheng. The modifications in this repository are released under the
same MIT license as the upstream projects (see LICENSE).
