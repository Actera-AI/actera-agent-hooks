# Changelog

## 0.3.2

- Claude Code reports `AskUserQuestion` outcomes again. Claude adds the person's `answers` and
  `annotations` to the tool input after `PreToolUse`, so the result no longer matched the
  admitted call and status showed a delivery error for every question, including the Claude Code
  plugin's own review prompt. The call is still bound to its questions; other tools are unchanged.

## 0.3.1

- The repository is public. The contract manifest names `Actera-AI/actera-api`, and the Codex
  MCP server reports the package version instead of a copy of it.

## 0.3.0

- Review held calls in Codex. `src/hosts/codex/mcp-server.mjs` is an MCP server for the
  plugin's `PreToolUse` `mcp_tool` hook. While a call is held, it asks the linked person to
  allow it once or deny it (MCP elicitation), and offers the reviewer link when Codex is not
  linked yet. A review in Actera still decides the call and withdraws the prompt.
- The Codex command line links the reviewer account with `link` and `link-status`.
- Codex approvals return no hook output: Codex 0.165 treats `permissionDecision: "allow"` as
  a hook failure, which let the call run but reported the hook as failed.
- Approving or rejecting as the linked person moved to the core (`reviewDecision`,
  `reviewedElsewhere`). Claude Code requests and messages are unchanged.

## 0.2.0

- Codex host adapter in `src/hosts/codex/`: decisions as `codex.tool.*` and `codex.mcp.*`,
  approvals held in the hook until a reviewer decides, outcomes read from the Codex session
  transcript, and settings stored with the connection under `~/.actera/codex`.
- The Codex adapter leaves no process running after a hook: reports are delivered from the
  hook and the scanner runs once per call. A lingering helper made Codex wait indefinitely
  on the first call of a session.
- Browser pairing and setup codes live in the core (`src/core/pairing.mjs`) and name the
  connecting plugin, so Actera labels Codex connections as Codex.
- Codex messages name where to review a held call and carry a reviewer's rejection reason.
  Status reports when no hook has run, which means Codex has not trusted them.
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
