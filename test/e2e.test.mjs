/* End to end: Playwright's Chromium with the unpacked extension. Every hostname resolves to one local server
   (--host-resolver-rules), including eu.i.posthog.com and ciunkos.com, so anything that slips through shows up
   in the server's log. */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'

const OK_JS = 'window.__results.okRan = true'
const sri = (alg, bytes) => `${alg}-${createHash(alg).update(bytes).digest('base64')}`

const root = fileURLToPath(new URL('..', import.meta.url))
const fixtures = join(root, 'test', 'fixtures')

let server
let port
let context
let worker
let profile
const hits = []

const posthogLike = hit =>
  /posthog/i.test(hit.host) ||
  /\/(?:zz9|vendor\/posthog|hire\/ph|x7k2|a\/b\/flags|custom\/collect|relay|t\/track)/.test(hit.path)

before(async () => {
  server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    hits.push({ host: req.headers.host.split(':')[0], path: req.url, method: req.method, body })
    const name = req.url.split('?')[0].replace(/^\//, '')
    if (name === 'lib/sdk.mjs') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' })
      res.end(await readFile(join(root, 'node_modules', 'posthog-js', 'dist', 'module.js')))
      return
    }
    const assets = { 'assets/a1.js': 'array.js', 'assets/b2.js': 'array.full.js' }
    if (assets[name]) {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Access-Control-Allow-Origin': '*' })
      res.end(await readFile(join(root, 'node_modules', 'posthog-js', 'dist', assets[name])))
      return
    }
    if (name === 'assets/ok.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Access-Control-Allow-Origin': '*' })
      res.end(OK_JS)
      return
    }
    if (name === 'sri.html') {
      const dist = join(root, 'node_modules', 'posthog-js', 'dist')
      const html = (await readFile(join(fixtures, name), 'utf8'))
        .replace('{{OK}}', sri('sha384', OK_JS))
        .replace('{{ARRAY}}', sri('sha384', await readFile(join(dist, 'array.js'))))
        .replace('{{FULL}}', sri('sha256', await readFile(join(dist, 'array.full.js'))))
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }
    if (name.endsWith('.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(await readFile(join(fixtures, name)))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end('"server"')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port

  profile = await mkdtemp(join(tmpdir(), 'phb-'))
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${root}`,
      `--load-extension=${root}`,
      `--host-resolver-rules=MAP * 127.0.0.1`
    ]
  })
  worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'))
  // wait until onInstalled has registered the page layer
  for (let i = 0; i < 50; i++) {
    const ids = await worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map(s => s.id))
    if (ids.length) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
})

after(async () => {
  await context?.close()
  server?.close()
  if (profile) await rm(profile, { recursive: true, force: true })
})

const open = async (host, name) => {
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://${host}:${port}/${name}`)
  await page.waitForTimeout(400)
  return { page, errors }
}

const badge = async page =>
  worker.evaluate(async url => {
    const [tab] = await chrome.tabs.query({ url })
    return chrome.action.getBadgeText({ tabId: tab.id })
  }, page.url())

test('the official snippet gets the stub and never loads array.js', async () => {
  hits.length = 0
  const { page, errors } = await open('shop.test', 'snippet.html')
  const results = await page.evaluate(() => window.__results)
  assert.deepEqual(errors, [])
  assert.equal(results.blocked, true)
  assert.equal(results.flag, false)
  assert.equal(results.flagsCallback, true)
  assert.deepEqual(results.scripts, [], 'no SDK <script> was added')
  assert.deepEqual(hits.filter(posthogLike), [])
  await page.close()
})

test('ciunkos.com: the loader bails out, the vendored SDK and /hire/ph are blocked', async () => {
  hits.length = 0
  const { page, errors } = await open('ciunkos.com', 'ciunkos.html')
  const results = await page.evaluate(() => window.__results)
  assert.deepEqual(errors, [])
  assert.equal(results.bailed, true)
  assert.equal(results.proxy, '{}', 'fake answer from the page layer')
  assert.equal(results.vendorBlocked, true, 'network rule blocked the SDK file')
  assert.deepEqual(hits.filter(posthogLike), [])
  assert.ok(Number(await badge(page)) >= 2, 'badge counts both layers')
  await page.close()
})

test('a bundled SDK on custom proxy paths is defused by URL and by payload', async () => {
  hits.length = 0
  const { page, errors } = await open('shop.test', 'bundled.html')
  await page.evaluate(() => window.__done)
  const results = await page.evaluate(() => window.__results)
  assert.deepEqual(errors, [])
  assert.deepEqual(results.fingerprint, {})
  assert.deepEqual(results.flags.featureFlags, {})
  assert.deepEqual(results.xhrBody, { status: 200, text: '{}' })
  assert.equal(results.blobBody, '{}')
  assert.equal(results.requestBody, '{}')
  assert.equal(results.beacon, true)
  assert.deepEqual(hits.filter(posthogLike), [])
  // controls went through
  assert.equal(results.controlFetch, '"server"')
  assert.equal(results.controlXhr.text, '"server"')
  assert.ok(hits.some(h => h.path === '/api/save' && h.body.includes('we use posthog')))
  await page.close()
})

test('the real posthog-js module sends nothing through its custom proxy', async () => {
  hits.length = 0
  const { page, errors } = await open('shop.test', 'real.html')
  await page.waitForFunction(() => window.__ready)
  await page.waitForTimeout(2500)
  assert.deepEqual(errors, [])
  assert.ok(hits.some(h => h.path === '/lib/sdk.mjs'), 'the SDK itself loaded')
  assert.deepEqual(hits.filter(posthogLike), [])
  await page.close()
})

test('renamed SDK files are stopped by their SRI hash, other scripts run', async () => {
  hits.length = 0
  const { page, errors } = await open('shop.test', 'sri.html')
  await page.waitForTimeout(800)
  const results = await page.evaluate(() => window.__results)
  assert.deepEqual(errors, [])
  assert.equal(results.okRan, true, 'control script ran')
  assert.equal(results.afterHtml, 'undefined', 'array.js in the HTML did not run')
  assert.equal(results.afterDynamic, 'undefined', 'array.full.js added from JS did not run')
  assert.equal(results.dynamicError, true)
  assert.equal(results.dynamicLoad, undefined)
  assert.ok(!hits.some(h => h.path === '/assets/b2.js'), 'the dynamic one was not even fetched')
  assert.deepEqual(
    await page.evaluate(() => [...document.querySelectorAll('[data-posthog-blocker]')].map(s => s.getAttribute('src'))),
    ['/assets/a1.js', '/assets/b2.js']
  )
  await page.close()
})

test('the page layer stays out of the PostHog app', async () => {
  const { page } = await open('eu.posthog.com', 'snippet.html')
  const results = await page.evaluate(() => window.__results)
  assert.equal(results.blocked, false, 'window.posthog is the page\'s own')
  await page.close()
})

test('pausing a site lets its PostHog traffic through, and only there', async () => {
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ paused: ['shop.test'] })
    await sync() // eslint-disable-line no-undef
  })
  hits.length = 0
  const { page } = await open('shop.test', 'bundled.html')
  await page.evaluate(() => window.__done)
  assert.ok(hits.some(h => h.path === '/custom/collect'), 'body-matched XHR reached the server')
  assert.ok(hits.some(h => h.path.startsWith('/x7k2/e/')), 'URL-matched fetch reached the server')
  await page.close()

  hits.length = 0
  const real = await open('shop.test', 'real.html')
  await real.page.waitForTimeout(2500)
  assert.ok(hits.some(h => h.path.startsWith('/zz9/')), 'without the blocker the real SDK does send')
  await real.page.close()

  const sriPage = await open('shop.test', 'sri.html')
  await sriPage.page.waitForTimeout(800)
  const sriResults = await sriPage.page.evaluate(() => window.__results)
  assert.equal(sriResults.afterHtml, 'object', 'without the blocker array.js runs')
  assert.equal(sriResults.dynamicLoad, true)
  await sriPage.page.close()

  hits.length = 0
  const other = await open('ciunkos.com', 'ciunkos.html')
  assert.deepEqual(hits.filter(posthogLike), [], 'other sites stay blocked')
  await other.page.close()

  await worker.evaluate(async () => {
    await chrome.storage.local.set({ paused: [] })
    await sync() // eslint-disable-line no-undef
  })
})
