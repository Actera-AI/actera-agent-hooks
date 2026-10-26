# Actera agent hooks

Evaluate a coding agent's tool calls against Actera policies before they run, and
report what happened afterwards. The package holds the host-neutral bridge (the
connection, durable report queue, delivery worker, local secret redaction and
approval reuse) and one adapter per agent host. Claude Code is the only host so far.

Licensed under [Apache-2.0](LICENSE). The repository is private while the package
layout settles. The Actera service requires an account.

## Layout

| Path | Contents |
| --- | --- |
| `src/core/` | Connection, queue, delivery worker, input capture and scanner client. No host field names. |
| `src/hosts/claude-code/` | Maps Claude Code hook events to decisions and reports, and Decisions back to `PreToolUse` output. Also the `actera-hook.mjs` command line. |
| `bin/delivery-worker.mjs` | The background sender the core spawns per bridge directory. |
| `vendor/gitleaks/` | Six verified Gitleaks helper builds and their notices. |
| `scanner/` | Go source for the helper. |
| `contract/` | The pinned Actera API contract the core is checked against. |

## Consuming the package

Agent hosts load plugins from a folder without installing dependencies, so a host
vendors the packed archive rather than importing it from `node_modules`:

```sh
npm pack
```

The Claude Code plugin copies the archive's contents to `plugins/actera/vendor/agent-hooks`
and records each file's SHA-256, so its installation check covers the vendored files.
Its `bin/actera-hook.mjs` only imports `src/hosts/claude-code/cli.mjs`.

State lives under `~/.actera/claude-code` (or `ACTERA_CLAUDE_BRIDGE_HOME`), unchanged
from the plugin, so existing connections, queued reports and approvals carry over.

## Checks

Run with Node.js 22+ and Go 1.27.0:

```sh
npm test
npm run check:package
node scripts/bundle-gitleaks.mjs
node scripts/scanner-notices.mjs --check
```

`npm test` runs the contract check and the offline suites against local HTTP
fixtures. See [CONTRIBUTING.md](CONTRIBUTING.md) for scanner builds and contract updates.
