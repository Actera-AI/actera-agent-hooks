# Measuring scanner performance

Run `node scripts/benchmark-capture.mjs` from the repository root. No Actera
service or model credentials are needed. It uses synthetic inputs and writes
results to ignored `.tools/capture-benchmark.json`, including CPU, OS, Node version,
sample counts, median, p95 and maximum times.

The benchmark measures cold helper startup, warm captures, and captures in fresh
Node hook processes. Capture includes binary checksum verification, helper
authentication, local HTTP requests, Gitleaks detection, redaction and metadata.
It excludes the Actera API and model latency. The baseline fresh process imports
the same modules without capturing input. The helper reuses compiled rules, never
input values, and exits after five idle minutes.

Typical warm shell/message capture and fresh-process capture p95 must be below
50 ms for this local acceptance check. The script exits nonzero otherwise.
Run without competing builds. Hardware, filesystem caches and host load affect
results; this is not a shared-CI timing gate or production latency guarantee.
Near-limit inputs are measured separately.

For the authenticated helper round trip alone, build a helper from `scanner/`
with `go build -o ../.tools/scanner-benchmark.exe .`, then run
`node scripts/benchmark-scanner.mjs .tools/scanner-benchmark.exe` from the root.
Use a suitable binary filename on Unix. Results go to
`.tools/scanner-benchmark.json`; this excludes Node hook startup and capture logic.

Correctness, privacy, failure and recovery coverage lives in `test/unit`.
Real host and service checks live with each host, such as the Claude Code plugin.
See [contributing](../CONTRIBUTING.md) for bundle reproducibility checks.
