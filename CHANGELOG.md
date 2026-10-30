# Changelog

## 0.2.0

- Codex host adapter in `src/hosts/codex/`: decisions as `codex.tool.*` and `codex.mcp.*`,
  approvals held in the hook until a reviewer decides, outcomes read from the Codex session
  transcript, and settings stored with the connection under `~/.actera/codex`.
- The Codex adapter leaves no process running after a hook: reports are delivered from the
  hook and the scanner runs once per call. A lingering helper made Codex wait indefinitely
  on the first call of a session.
- The core can keep a host's scanner cache in that host's bridge folder, scan with a private
  one-shot helper, and look up a Decision's narrow status. Claude Code behavior is unchanged.

## 0.1.0

- Extracted from the Claude Code plugin (`plugins/actera/lib` at `bb09494`). The
  bridge is split into a host-neutral core and a Claude Code adapter. Decision
  requests, execution reports, idempotency keys, local state and command output
  are unchanged.
- The scanner Go module is now `github.com/Actera-AI/actera-agent-hooks/scanner`,
  so the six helper builds were rebuilt. Gitleaks and every linked dependency are
  the same versions.
