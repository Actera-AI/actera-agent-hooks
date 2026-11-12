# Changelog

## 0.5.1

- GitHub Copilot: the adapter works when the host sends no tool call ID, as the Copilot
  runtime inside VS Code does. Before, Enforcing denied every call there when set to block
  on an evaluation failure (the default) and let every call run unchecked when set to
  allow, and Monitoring recorded calls late and without outcomes. A call is tied to its
  outcome by its session, tool and exact arguments; of several such calls the post hook
  takes the newest one still waiting. An MCP tool's server comes from the session log's
  records of that tool. A call without a session is still checked.

## 0.5.0

- GitHub Copilot: a new adapter in `src/hosts/copilot/` for the Copilot CLI's native hook
  events. Actions are `copilot.tool.<tool>` with Copilot's own tool names, and
  `copilot.mcp.<tool>` for MCP tools, whose server comes from the Copilot session. Held calls
  are denied with a review link before Copilot's hook timeout, and an identical retry reuses
  the approval once. A shell command that exits with an error is reported as `FAILURE`,
  although Copilot runs `postToolUse` for it. Pairing and setup codes send
  `client: "copilot"`, which needs an Actera API that accepts it.
- The file-based mode settings and the held-call polling move from the Codex adapter to
  `src/core/` so Codex and Copilot share them. The `./codex/settings` export is now
  `./core/settings`, and `holdForApproval` is exported from `./core` only. Codex behavior is
  unchanged.
- A hold with no time left still looks up the Decision once, so its denial has the review
  link. Settings of the wrong shape count as unreadable, and setting the mode again repairs
  an unreadable file.
- A held call's saved approval keeps its redacted request, so a retry that reuses the Decision
  can report against the action Actera captured.

## 0.4.2

- Claude Code: reviewing a held call no longer claims the approval. The plugin's mod runs the
  PreToolUse hook again, and that run claims it and releases the call, so an approval still
  releases one call. A plugin that vendors this version needs a mod that does the same.
- Claude Code: hooks save the plugin's options, so `status` reports them without taking them as
  arguments.

## 0.4.1

- A 429 from Actera now honours `Retry-After`, capped at one hour so a plan change is noticed.
  Before, the delivery worker retried every 30 seconds until the limit reset.
- A monthly limit now has plain wording in status and in any denied tool call, and Claude Code
  shows the person a message at most once a day. Enforcement behavior is unchanged.

## 0.4.0

- Disconnecting also ends the connection in Actera. After queued reports are delivered, the
  bridge calls `POST /v1/connection/disconnect` (API contract 0.8.0) with its key, so the
  agent's connection shows Disconnected and the key stops working. A 401 means the key was
  already revoked. If Actera cannot be reached or refuses, local state is still removed, and the
  result has `revoked: false` with a `revokeError` asking the person to disconnect the agent in
  Actera. Needs an Actera API that serves the endpoint.

## 0.3.3

- A held Codex call no longer waits silently when Codex cannot show the review prompt. Under
  approval policy `never` (Full access in the Codex app) and in `codex exec`, Codex declines
  the prompt without showing it, so the hook used to hold for up to 540 seconds while Codex
  showed only "thinking". Now a declined or dismissed prompt, or a Codex without elicitation
  support, ends the hold at once and denies the call with a reason that asks the agent to get
  it approved in Actera and retry. The retry reuses the held Decision. Choosing "Wait for a
  reviewer" still holds as before.

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
