/* Checks rules/posthog.json (through a small declarativeNetRequest evaluator) and the page layer's matchers
   (src/inject.js, evaluated in a sandbox) against the same URLs, so the two layers can't drift apart. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const rules = JSON.parse(await readFile(new URL('../rules/posthog.json', import.meta.url), 'utf8'))

/* --- declarativeNetRequest subset: requestDomains, initiatorDomains, resourceTypes, urlFilter, regexFilter --- */
const domainMatch = (host, domains) => domains.some(d => host === d || host.endsWith(`.${d}`))
const urlFilterMatch = (filter, url) => {
  if (filter.startsWith('||')) {
    const rest = filter.slice(2).replace(/\^$/, '')
    const { hostname, href } = new URL(url)
    const [host] = rest.split('/')
    return domainMatch(hostname, [host]) && href.includes(rest)
  }
  return url.toLowerCase().includes(filter.toLowerCase())
}
const ruleMatches = (rule, { url, type, initiator }) => {
  const c = rule.condition
  const host = new URL(url).hostname
  const types = c.resourceTypes || (c.excludedResourceTypes ? null : null)
  if (types && !types.includes(type)) return false
  if (!c.resourceTypes && type === 'main_frame') return false
  if (c.excludedResourceTypes && c.excludedResourceTypes.includes(type)) return false
  if (c.requestDomains && !domainMatch(host, c.requestDomains)) return false
  if (c.initiatorDomains && !(initiator && domainMatch(new URL(initiator).hostname, c.initiatorDomains))) return false
  if (c.urlFilter && !urlFilterMatch(c.urlFilter, url)) return false
  if (c.regexFilter && !new RegExp(c.regexFilter, c.isUrlFilterCaseSensitive ? '' : 'i').test(url)) return false
  return true
}
/* Highest priority wins; at equal priority allow beats block. allowAllRequests from the frame covers its requests. */
const blocked = request => {
  const frame = request.frame
  if (frame && rules.some(r => r.action.type === 'allowAllRequests' && ruleMatches(r, { url: frame, type: 'main_frame' }))) {
    return false
  }
  const hits = rules.filter(r => r.action.type !== 'allowAllRequests' && ruleMatches(r, request))
  if (!hits.length) return false
  const top = Math.max(...hits.map(r => r.priority || 1))
  return !hits.some(r => (r.priority || 1) === top && r.action.type === 'allow')
}

/* --- page layer --- */
const source = await readFile(new URL('../src/inject.js', import.meta.url), 'utf8')
const sri = await readFile(new URL('../src/sri-hashes.js', import.meta.url), 'utf8')
let page
vm.runInNewContext(`${sri};\n${source}`, {
  __PHB_EXPORT__: exported => { page = exported },
  location: { href: 'https://shop.example/' },
  URL,
  URLSearchParams,
  TextDecoder,
  ArrayBuffer
})

const SITE = 'https://shop.example/'
const TOKEN = 'phc_TestTokenForPostHogBlockerFixtures000000000'

/* [url, resource type] that must be blocked */
const positives = [
  ['https://eu.i.posthog.com/e/?ip=0&_=1730000000000&ver=1.200.0', 'xmlhttprequest'],
  ['https://us.i.posthog.com/flags/?v=2', 'xmlhttprequest'],
  ['https://us-assets.i.posthog.com/static/array.js', 'script'],
  ['https://eu-assets.i.posthog.com/array/' + TOKEN + '/config.js', 'script'],
  ['https://app.posthog.com/decide/?v=3', 'xmlhttprequest'],
  ['https://eu.posthog.com/static/array.js', 'script'],
  // ciunkos.com: self-hosted SDK and the hire Worker proxy
  ['https://ciunkos.com/vendor/posthog/1.439.0-f32a5541/posthog.js', 'script'],
  ['https://ciunkos.com/hire/ph/e/?compression=gzip-js&_=1730000000000', 'xmlhttprequest'],
  ['https://ciunkos.com/hire/ph/flags/?v=2&config=true', 'xmlhttprequest'],
  ['https://ciunkos.com/hire/ph/s/', 'xmlhttprequest'],
  ['https://ciunkos.com/hire/ph/array/' + TOKEN + '/config', 'xmlhttprequest'],
  ['https://przemyslawzalewski.pl/ph/i/v0/e/', 'ping'],
  ['https://ciunkos.com/email-spam-test/ph/e/', 'xmlhttprequest'],
  // common proxies
  ['https://shop.example/ingest/static/array.js', 'script'],
  ['https://shop.example/ingest/e/', 'xmlhttprequest'],
  ['https://shop.example/ingest/flags/?v=2', 'xmlhttprequest'],
  ['https://shop.example/posthog/ingest/s/?compression=gzip-js', 'xmlhttprequest'],
  ['https://shop.example/_ph/decide/', 'xmlhttprequest'],
  // custom proxy paths, caught by the query fingerprint
  ['https://shop.example/x7k2/e/?compression=gzip-js&_=1730000000000', 'xmlhttprequest'],
  ['https://shop.example/relay/i/v0/e/?ip=1&_=1730000000000', 'ping'],
  ['https://shop.example/t/s/?compression=gzip-js&_=1730000000000', 'xmlhttprequest'],
  ['https://shop.example/a/b/flags/?v=2', 'xmlhttprequest'],
  ['https://shop.example/q/i/v1/logs?retry_count=1', 'xmlhttprequest'],
  ['https://telemetry.shop.example/collect?compression=gzip-js', 'xmlhttprequest'],
  ['https://shop.example/api/surveys/?token=' + TOKEN, 'xmlhttprequest'],
  // SDK files under any name
  ['https://shop.example/assets/posthog.min.js', 'script'],
  ['https://shop.example/_next/static/chunks/posthog-js.3f2a9c.js', 'script'],
  ['https://shop.example/js/posthog-recorder.js', 'script'],
  ['https://cdn.jsdelivr.net/npm/posthog-js@1/dist/array.js', 'script'],
  ['https://unpkg.com/posthog-js@1.200.0/dist/module.js', 'script'],
  ['https://shop.example/static/1.439.0/lazy-recorder.js', 'script']
]

/* [url, resource type, initiator?] that must load */
const negatives = [
  ['https://eu.posthog.com/project/1/insights', 'main_frame'],
  ['https://us.posthog.com/', 'main_frame'],
  ['https://posthog.com/docs/libraries/js', 'main_frame'],
  ['https://eu.posthog.com/api/projects/1/insights/', 'xmlhttprequest', 'https://eu.posthog.com/project/1'],
  ['https://eu.i.posthog.com/e/', 'xmlhttprequest', 'https://eu.posthog.com/project/1'],
  ['https://shop.example/e/', 'xmlhttprequest'],
  ['https://shop.example/s/', 'xmlhttprequest'],
  ['https://shop.example/flags/', 'xmlhttprequest'],
  ['https://shop.example/flags', 'main_frame'],
  ['https://shop.example/static/app.js', 'script'],
  ['https://shop.example/static/surveys.js', 'script'],
  ['https://shop.example/js/web-vitals.js', 'script'],
  ['https://shop.example/api/search?q=posthog', 'xmlhttprequest'],
  ['https://shop.example/blog/posthog-vs-mixpanel', 'main_frame'],
  ['https://shop.example/img/hedgehog.png', 'image'],
  ['https://shop.example/graph/e/', 'xmlhttprequest'],
  ['https://ciunkos.com/hire/', 'main_frame'],
  ['https://ciunkos.com/apps', 'main_frame'],
  ['https://ciunkos.com/hire/api/agent', 'xmlhttprequest'],
  ['https://shop.example/phone/e/', 'xmlhttprequest']
]

/* XHR-like types are what the page layer sees (fetch, XHR, beacon). */
const PAGE_TYPES = new Set(['xmlhttprequest', 'ping'])

test('every rule compiles as a regex RE2 also accepts (no lookaround, no backreferences)', () => {
  for (const rule of rules) {
    const re = rule.condition.regexFilter
    if (!re) continue
    assert.doesNotThrow(() => new RegExp(re))
    assert.doesNotMatch(re, /\(\?[=!<]|\\[1-9]/, `rule ${rule.id}`)
  }
  assert.equal(new Set(rules.map(r => r.id)).size, rules.length, 'unique rule ids')
})

test('network rules block PostHog requests', () => {
  for (const [url, type] of positives) {
    assert.ok(blocked({ url, type, initiator: SITE, frame: SITE }), `${type} ${url}`)
  }
})

test('network rules leave the PostHog app and ordinary requests alone', () => {
  for (const [url, type, initiator] of negatives) {
    const frame = type === 'main_frame' ? url : initiator || SITE
    assert.ok(!blocked({ url, type, initiator: initiator || SITE, frame }), `${type} ${url}`)
  }
})

test('page layer agrees with the network rules on requests it sees', () => {
  for (const [url, type] of positives) {
    if (PAGE_TYPES.has(type)) assert.ok(page.matchUrl(url), `page layer misses ${url}`)
  }
  for (const [url, type, initiator] of negatives) {
    if (PAGE_TYPES.has(type) && !initiator) assert.equal(page.matchUrl(url), null, `page layer blocks ${url}`)
  }
})

test('page layer recognises PostHog payloads on any URL', () => {
  const event = JSON.stringify({ event: '$pageview', properties: { token: TOKEN, distinct_id: 'x' } })
  assert.equal(page.matchBody(event), 'payload')
  assert.equal(page.matchBody(JSON.stringify({ api_key: TOKEN, batch: [] })), 'payload')
  assert.equal(page.matchBody(new TextEncoder().encode(event)), 'payload')
  assert.equal(page.matchBody(new URLSearchParams({ data: event })), 'payload')
  assert.equal(page.matchBody(JSON.stringify({ q: 'phc_short' })), null)
  assert.equal(page.matchBody(JSON.stringify({ comment: 'we use posthog' })), null)
  assert.equal(page.matchBody(null), null)
})

test('known SDK builds are recognised by their SRI hash', async () => {
  const { createHash } = await import('node:crypto')
  const dist = new URL('../node_modules/posthog-js/dist/', import.meta.url)
  const sha = (alg, bytes) => `${alg}-${createHash(alg).update(bytes).digest('base64')}`
  assert.ok(page.sriSize > 1000, `${page.sriSize} hashes loaded`)
  const arrayJs = await readFile(new URL('array.js', dist))
  const { version } = JSON.parse(await readFile(new URL('../package.json', dist), 'utf8'))
  const { npm } = JSON.parse(await readFile(new URL('../data/sri.json', import.meta.url), 'utf8'))
  const known = npm[version] && npm[version].files['array.js']
  assert.ok(known, `posthog-js ${version} is in data/sri.json (run scripts/sri-hashes.mjs)`)
  // sha384 / sha512 only exist for recent releases (--bytes-days)
  for (const alg of Object.keys(known)) assert.equal(page.matchIntegrity(sha(alg, arrayJs)), 'sri', alg)
  assert.equal(page.matchIntegrity(`sha512-AAAA ${sha('sha256', arrayJs)}?ct=application/javascript`), 'sri')
  // ciunkos.com vendored build, from versions.json
  assert.equal(page.matchIntegrity('sha384-7tPSHdDbq6CQO0xfuWHqd7w3VefViVXx4eNX/PX8SqAeaMolupVqzMIf22ryGp40'), 'sri')
  assert.equal(page.matchIntegrity(sha('sha384', Buffer.from('console.log(1)'))), null)
  assert.equal(page.matchIntegrity(''), null)
})
