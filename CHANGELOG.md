# Changelog

## 0.1.0

- Extracted from the Claude Code plugin (`plugins/actera/lib` at `bb09494`). The
  bridge is split into a host-neutral core and a Claude Code adapter. Decision
  requests, execution reports, idempotency keys, local state and command output
  are unchanged.
- The scanner Go module is now `github.com/Actera-AI/actera-agent-hooks/scanner`,
  so the six helper builds were rebuilt. Gitleaks and every linked dependency are
  the same versions.
