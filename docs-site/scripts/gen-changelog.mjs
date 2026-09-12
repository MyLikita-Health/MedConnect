/**
 * Generates docs-site/changelog.md from the GitHub Releases API at build
 * time — the page updates itself on every deploy, with zero maintenance.
 *
 * Failure mode: the file is gitignored, and callers run this via npm pre
 * hooks with `|| true`, so an offline build (or API hiccup) keeps whatever
 * generated copy exists rather than failing the build.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const REPO = 'MyLikita-Health/MedConnect'
// docs-site/changelog.md — relative to THIS script (scripts/).
const OUT = fileURLToPath(new URL('../changelog.md', import.meta.url))

let raw
try {
  raw = execFileSync('curl', [
    '-sS', '--max-time', '20',
    `https://api.github.com/repos/${REPO}/releases?per_page=30`,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
} catch {
  console.warn('[changelog] releases fetch failed — keeping any existing generated page')
  process.exit(0)
}

/** Release bodies are written by our release workflow; render them lightly. */
function renderBody(body) {
  return (body || '')
    // Strip the release-bot trailer (contributor list at the bottom).
    .replace(/_+Generated with.*$/s, '')
    .replace(/\n---\s*$/, '')
    // Autolink #123 issue references to the repo.
    .replace(/(^|\s)#(\d+)\b/g, '$1[#$2](https://github.com/' + REPO + '/issues/$2)')
    .trim()
}

let releases
try {
  releases = JSON.parse(raw)
} catch {
  console.warn('[changelog] unexpected API response — keeping any existing generated page')
  process.exit(0)
}

const lines = [
  '---',
  'layout: page',
  '---',
  '',
  '# Changelog',
  '',
  'Release notes, rendered from',
  `[GitHub Releases](https://github.com/${REPO}/releases) whenever this site`,
  'is built. Assets for every release carry a SHA-256 checksums file',
  '(`SHA256SUMS.txt`); the update agent additionally verifies the',
  'Ed25519-signed update manifest before applying anything — see the',
  '[security statement](/reference/security#updates-and-supply-chain).',
  '',
]

for (const r of releases) {
  const badge = r.prerelease ? ' `pre-release`' : ''
  const date = (r.published_at || '').slice(0, 10)
  lines.push(`## ${r.name || r.tag_name}${badge}`)
  lines.push('')
  const bits = []
  if (date) bits.push(date)
  bits.push(`[release page](https://github.com/${REPO}/releases/tag/${r.tag_name})`)
  if (r.assets?.length) bits.push(`${r.assets.length} asset${r.assets.length === 1 ? '' : 's'}`)
  lines.push(`*${bits.join(' · ')}*`)
  lines.push('')
  const body = renderBody(r.body)
  if (body) lines.push(body, '')
}

writeFileSync(OUT, lines.join('\n'))
console.log(`[changelog] wrote ${releases.length} release(s) to changelog.md`)
