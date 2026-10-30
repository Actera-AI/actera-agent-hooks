// The packed archive is what hosts vendor, so check it rather than the checkout:
// exact runtime files, every relative import resolvable inside the archive,
// and scanner bundles that still match their manifest.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const root = fileURLToPath(new URL('../', import.meta.url))
// Run npm through Node itself so no shell is involved.
const npmCli = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]
  .find(file => file?.endsWith('npm-cli.js') && existsSync(file))
const pack = ['pack', '--dry-run', '--json', '--ignore-scripts']
const output = npmCli
  ? execFileSync(process.execPath, [npmCli, ...pack], { cwd: root, encoding: 'utf8' })
  : execFileSync('npm', pack, { cwd: root, encoding: 'utf8' })
const [packed] = JSON.parse(output)
const files = packed.files.map(file => file.path).sort()
const platforms = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']
const expected = [
  'LICENSE', 'NOTICE', 'README.md', 'package.json',
  'bin/delivery-worker.mjs',
  'src/core/bridge.mjs', 'src/core/defaults.mjs', 'src/core/delivery.mjs', 'src/core/generated/outcomes.mjs',
  'src/core/input-capture.mjs', 'src/core/pairing.mjs', 'src/core/scanner-client.mjs',
  'src/hosts/claude-code/bridge.mjs', 'src/hosts/claude-code/cli.mjs', 'src/hosts/claude-code/settings.mjs',
  'src/hosts/codex/bridge.mjs', 'src/hosts/codex/cli.mjs', 'src/hosts/codex/settings.mjs',
  'vendor/gitleaks/LICENSE', 'vendor/gitleaks/THIRD_PARTY_NOTICES.txt', 'vendor/gitleaks/manifest.json',
  ...platforms.map(platform => `vendor/gitleaks/${platform}.gz`),
].sort()
assert.deepEqual(files, expected, 'Packed files differ from the reviewed runtime payload')

for (const file of files.filter(name => name.endsWith('.mjs'))) {
  const source = readFileSync(new URL(file, new URL('../', import.meta.url)), 'utf8')
  for (const [, specifier] of source.matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g)) {
    const target = posix.normalize(posix.join(posix.dirname(file), specifier))
    assert.ok(files.includes(target), `${file} imports ${specifier}, which is not packed`)
  }
  for (const [, specifier] of source.matchAll(/new URL\('(\.{1,2}\/[^']+)', import\.meta\.url\)/g)) {
    const target = posix.normalize(posix.join(posix.dirname(file), specifier))
    assert.ok(files.some(name => name === target || name.startsWith(target.endsWith('/') ? target : target + '/')), `${file} references ${specifier}, which is not packed`)
  }
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const manifest = JSON.parse(readFileSync(new URL('../vendor/gitleaks/manifest.json', import.meta.url), 'utf8'))
for (const platform of platforms) {
  const entry = manifest.binaries[platform]
  const bytes = readFileSync(new URL(`../vendor/gitleaks/${entry.file}`, import.meta.url))
  assert.equal(hash(bytes), entry.compressedSha256, `Scanner bundle changed: ${platform}`)
  assert.equal(hash(gunzipSync(bytes)), entry.sha256, `Scanner bundle changed: ${platform}`)
}
console.log(`${packed.name}@${packed.version}: ${files.length} packed files verified`)
