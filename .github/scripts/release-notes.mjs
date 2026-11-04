// Prints the CHANGELOG.md section for one version, so a release's notes are
// its changelog entry. Fails when the section is missing or empty.
//   node .github/scripts/release-notes.mjs 0.3.3
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function releaseNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/)
  const start = lines.indexOf(`## ${version}`)
  if (start < 0) throw new Error(`CHANGELOG.md has no "## ${version}" section`)
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  const notes = lines.slice(start + 1, next < 0 ? undefined : next).join('\n').trim()
  if (!notes) throw new Error(`CHANGELOG.md has an empty "## ${version}" section`)
  return notes + '\n'
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.stdout.write(releaseNotes(readFileSync('CHANGELOG.md', 'utf8'), process.argv[2]))
