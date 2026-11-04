import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { releaseNotes } from './release-notes.mjs'

const changelog = '# Changelog\n\n## 0.2.0\n\n- Second.\n\n## 0.1.0\n\n- First.\n'

test('release notes are the changelog section for that version', () => {
  assert.equal(releaseNotes(changelog, '0.2.0'), '- Second.\n')
  assert.equal(releaseNotes(changelog, '0.1.0'), '- First.\n')
  assert.equal(releaseNotes(changelog.replaceAll('\n', '\r\n'), '0.2.0'), '- Second.\n')
  assert.throws(() => releaseNotes(changelog, '0.3.0'), /no "## 0.3.0" section/)
  assert.throws(() => releaseNotes('## 0.4.0\n\n## 0.3.0\n- x\n', '0.4.0'), /empty/)
  assert.throws(() => releaseNotes(changelog, '0.1'), /no "## 0.1" section/)
})

test('the current package version has release notes', () => {
  const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  assert.ok(releaseNotes(readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8'), version))
})
