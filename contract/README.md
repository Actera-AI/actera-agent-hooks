# API compatibility

This package pins the authoritative customer API snapshot and its checksum in
[manifest.json](manifest.json). This checkout uses API 0.7.0. Keep the snapshot
intact: it is shared with the SDKs and includes managed-execution operations the
package does not call. It is a development input, not part of the packed archive.

`generate-outcomes.mjs` generates execution outcome constants from that snapshot.
`check-contract.mjs` verifies its digest, references, six consumed customer API
operations, required execution outcomes and decision correlation fields. It does
not validate every handwritten request at runtime. Offline fixtures and live
integration tests cover those requests and the native HTTP/browser pairing routes
outside the customer API snapshot.

Import changes from an exact `actera-api` release with
`node scripts/update-contract.mjs <actera-api-checkout>`, regenerate with
`npm run generate:outcomes`, then review the bridge and run integration tests.
Do not hand-edit the snapshot or generate another independent wire contract.

## Routes and authority

| Endpoint                               | Purpose / authority                                         |
| -------------------------------------- | ----------------------------------------------------------- |
| POST /v1/decisions                      | Evaluate a tool call using the scoped machine key             |
| POST /v1/decisions/{id}/reports        | Append reported execution evidence to the decision      |
| POST /v1/reviewer-links                | Start human reviewer linking                                |
| GET /auth/reviewer-link                | Browser sign-in and reviewer linking                        |
| POST /auth/reviewer-link/confirm       | Confirm through the signed-in browser session               |
| GET /v1/reviewer-links/status          | Poll reviewer linking status                                |
| GET /v1/decisions/{id}/status          | Read correlated, narrow Decision status                     |
| GET /v1/agents/{agent_id}/readiness    | Verify the bound agent's readiness                          |
| POST /v1/decisions/{id}/approve        | Human reviewer approval                                     |
| POST /v1/decisions/{id}/reject         | Human reviewer rejection                                    |
| POST /v1/agent-connections             | Start a short-lived local-to-browser pairing                |
| POST /v1/agent-connections/{code}/redeem | Redeem an approved key with the local claim               |
| GET /v1/identity/agent-connections/{code} | Check connection approval/delivery in a signed-in browser       |
| POST /v1/identity/workspaces/{workspace_id}/agent-connections/{code}/approve | Admin approval for one registered agent |

The machine key evaluates calls and reports execution. Human approval uses a
separate browser-linked reviewer credential; pairing requires an administrator.
The redemption claim remains in the local process, and the returned agent key is
encrypted to the installation's public key. Pairing retries return the same
approved encrypted result until expiry.

## Results and local state

Each `PreToolUse` requests a policy decision. Claude's native settings choose
Monitoring or Enforcing; readiness and agent configuration never select mode.
Only Enforcing applies policy denials and reviewer approval. Claude permission
denials still apply when Actera allows a call.

`PostToolUse` reports `SUCCESS`; `PostToolUseFailure` reports `FAILURE`, or
`CANCELLED` when interrupted. `UNKNOWN` is available in the shared contract for an
executor that cannot determine its result. No execution event means no execution
report. Policy result and actual execution outcome remain separate; there is no
derived enforcement outcome. These reports describe host execution, not proof of
an external business effect.

The bridge stores credentials and correlation in version 3 local configuration.
Mode and evaluation-failure choices belong to Claude's settings. Monitoring can
queue the original decision request and evaluate it on recovery before sending
its outcome. That evaluation uses the then-current policies; the original
failure is visible in local status, not appended to the recovered outcome report.
