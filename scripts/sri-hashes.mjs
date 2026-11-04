/* Builds the list of SRI hashes of known PostHog SDK files, for sites that self-host the SDK under a new name
   but keep the integrity attribute (<script src="/assets/a1b2.js" integrity="sha384-…">).

   - sha256 of the SDK files of every posthog-js release in the last --days (default 365), from jsDelivr's
     package listing (no downloads; its hashes are of the npm files).
   - sha384 and sha512 (what SRI generators usually emit) of the main builds of releases in the last --bytes-days
     (default 90). These need the files, fetched from jsDelivr and checked against the listed sha256.
   - The ciunkos.com vendored builds (their integrity from ciunkos.com/vendor/posthog/versions.json).

   data/sri.json keeps full digests and is reused, so a rerun only fetches new releases.
   src/sri-hashes.js is generated from it: "alg-<first 12 base64 chars>" tokens, about 72 bits each.
   Usage: node scripts/sri-hashes.mjs [--days 365] [--bytes-days 90] */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? Number(process.argv[i + 1]) : fallback
}
const DAYS = arg('days', 365)
const BYTES_DAYS = arg('bytes-days', 90)
const PREFIX = 12

// what pages load with a <script> tag
const FILES = [
  'array.js',
  'array.full.js',
  'array.no-external.js',
  'array.full.no-external.js',
  'array.full.es5.js',
  'lazy-recorder.js',
  'posthog-recorder.js',
  'recorder.js',
  'recorder-v2.js'
]
// the ones worth downloading for sha384 / sha512
const BYTES_FILES = ['array.js', 'array.full.js', 'array.no-external.js', 'array.full.no-external.js', 'lazy-recorder.js']
const OWN_BUILDS = 'https://ciunkos.com/vendor/posthog/versions.json'

const dataUrl = new URL('../data/sri.json', import.meta.url)
const outUrl = new URL('../src/sri-hashes.js', import.meta.url)

let data = { npm: {}, own: {} }
try {
  data = JSON.parse(await readFile(dataUrl, 'utf8'))
} catch (error) {
  // first run
}

const times = JSON.parse(execFileSync('npm', ['view', 'posthog-js', 'time', '--json'], { encoding: 'utf8' }))
const now = Date.now()
const releases = Object.entries(times)
  .filter(([version]) => /^\d+\.\d+\.\d+$/.test(version))
  .map(([version, time]) => ({ version, age: (now - Date.parse(time)) / 864e5, published: time.slice(0, 10) }))
  .filter(release => release.age <= DAYS)

const pool = async (items, size, fn) => {
  const queue = [...items]
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (queue.length) await fn(queue.shift())
    })
  )
}
const get = async (url, as) => {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'posthog-blocker sri-hashes' } })
      if (!response.ok) throw new Error(`${response.status} ${url}`)
      return as === 'json' ? response.json() : Buffer.from(await response.arrayBuffer())
    } catch (error) {
      if (attempt >= 3) throw error
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)))
    }
  }
}
const digest = (alg, bytes) => createHash(alg).update(bytes).digest('base64')

let listed = 0
let downloaded = 0
await pool(releases, 8, async ({ version, age, published }) => {
  let entry = data.npm[version]
  if (!entry) {
    const listing = await get(`https://data.jsdelivr.com/v1/packages/npm/posthog-js@${version}?structure=flat`, 'json')
    entry = { published, files: {} }
    for (const file of listing.files) {
      const name = file.name.replace(/^\/dist\//, '')
      if (FILES.includes(name)) entry.files[name] = { sha256: file.hash }
    }
    data.npm[version] = entry
    listed++
  }
  if (age > BYTES_DAYS) return
  for (const name of BYTES_FILES) {
    const file = entry.files[name]
    if (!file || file.sha384) continue
    const bytes = await get(`https://cdn.jsdelivr.net/npm/posthog-js@${version}/dist/${name}`)
    if (digest('sha256', bytes) !== file.sha256) throw new Error(`sha256 mismatch: posthog-js@${version}/dist/${name}`)
    file.sha384 = digest('sha384', bytes)
    file.sha512 = digest('sha512', bytes)
    downloaded++
  }
})

try {
  const own = await get(OWN_BUILDS, 'json')
  for (const [build, { integrity }] of Object.entries(own.versions)) data.own[`ciunkos.com ${build}`] = integrity
} catch (error) {
  console.warn(`skipped ${OWN_BUILDS}: ${error.message}`)
}

// releases older than --days drop out, so the list injected into every page stays the same size
const current = new Set(releases.map(release => release.version))
for (const version of Object.keys(data.npm)) if (!current.has(version)) delete data.npm[version]

// stable order, so the generated files only change when hashes do
const sortVersions = (a, b) => b.localeCompare(a, 'en', { numeric: true })
data.npm = Object.fromEntries(Object.entries(data.npm).sort(([a], [b]) => sortVersions(a, b)))
data.own = Object.fromEntries(Object.entries(data.own).sort())

const tokens = new Set()
const add = (alg, b64) => tokens.add(`${alg}-${b64.slice(0, PREFIX)}`)
for (const { files } of Object.values(data.npm)) {
  for (const file of Object.values(files)) for (const alg of ['sha256', 'sha384', 'sha512']) if (file[alg]) add(alg, file[alg])
}
for (const integrity of Object.values(data.own)) {
  for (const token of integrity.split(/\s+/)) {
    const [alg, b64] = token.split('-')
    add(alg, b64)
  }
}

await mkdir(new URL('../data', import.meta.url), { recursive: true })
await writeFile(dataUrl, `${JSON.stringify(data, null, 1)}\n`)
const versions = Object.keys(data.npm)
await writeFile(
  outUrl,
  `/* GENERATED by scripts/sri-hashes.mjs from data/sri.json. Do not edit.
   SRI hash prefixes of PostHog SDK files: posthog-js ${versions.at(-1)} to ${versions[0]} (${versions.length} releases)
   and the ciunkos.com vendored builds. inject.js reads this and deletes it before any page script runs. */
Object.defineProperty(globalThis, Symbol.for('posthog-blocker.sri'), {
  configurable: true,
  value: '${[...tokens].sort().join(' ')}'
})
`
)
console.log(`${versions.length} releases (${listed} new listings, ${downloaded} files hashed), ${tokens.size} tokens`)
