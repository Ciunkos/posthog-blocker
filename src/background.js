/* PostHog Blocker, background.
   State in storage.local: { enabled, paused: [hostname] }. sync() applies it:
   - the static ruleset "posthog" (rules/posthog.json) on or off,
   - one dynamic allow pair per paused site (ids from 1000, priority above every static rule),
   - the MAIN-world page layer (src/inject.js) registered for every site except the paused ones.
   The badge counts network blocks (DNR action count) plus page-layer blocks (tabUpdate increments).
   Per-tab details for the popup live in storage.session, so they survive the worker going to sleep. */

const RULESET = 'posthog'
const INJECT_ID = 'posthog-blocker-inject'
const PAUSE_RULE_BASE = 1000
const STATIC_ALLOW_RULES = new Set([1, 2])
const RECENT_LIMIT = 40
const dnr = chrome.declarativeNetRequest
/* Chrome counts DNR blocks on the badge itself; Firefox has no action count, so the badge shows our own count there. */
const ACTION_COUNT = typeof dnr.setExtensionActionOptions === 'function'

const getState = async () => {
  const { enabled = true, paused = [] } = await chrome.storage.local.get(['enabled', 'paused'])
  return { enabled, paused }
}

const registerInject = async excludeHosts => {
  const script = {
    id: INJECT_ID,
    js: ['src/sri-hashes.js', 'src/inject.js'],
    matches: ['<all_urls>'],
    runAt: 'document_start',
    allFrames: true,
    world: 'MAIN',
    persistAcrossSessions: true
  }
  // the PostHog app runs its own posthog-js (feature flags); the network rules spare it too
  script.excludeMatches = ['*://posthog.com/*', '*://*.posthog.com/*', ...excludeHosts.map(host => `*://${host}/*`)]
  try {
    await chrome.scripting.registerContentScripts([{ ...script, matchOriginAsFallback: true }])
  } catch (error) {
    // Firefox without matchOriginAsFallback
    await chrome.scripting.registerContentScripts([script])
  }
}

let syncing = Promise.resolve()
const sync = () => {
  syncing = syncing.then(syncNow, syncNow)
  return syncing
}

const syncNow = async () => {
  const { enabled, paused } = await getState()

  await dnr.updateEnabledRulesets(
    enabled ? { enableRulesetIds: [RULESET] } : { disableRulesetIds: [RULESET] }
  )

  const existing = await dnr.getDynamicRules()
  const addRules = paused.flatMap((host, i) => [
    {
      id: PAUSE_RULE_BASE + i * 2,
      priority: 1000,
      action: { type: 'allowAllRequests' },
      condition: { requestDomains: [host], resourceTypes: ['main_frame', 'sub_frame'] }
    },
    {
      id: PAUSE_RULE_BASE + i * 2 + 1,
      priority: 1000,
      action: { type: 'allow' },
      condition: { initiatorDomains: [host] }
    }
  ])
  await dnr.updateDynamicRules({
    removeRuleIds: existing.map(rule => rule.id),
    addRules
  })

  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [INJECT_ID] })
  if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: [INJECT_ID] })
  if (enabled) await registerInject(paused)

  if (ACTION_COUNT) await dnr.setExtensionActionOptions({ displayActionCountAsBadgeText: enabled })
  await chrome.action.setBadgeBackgroundColor({ color: enabled ? '#d7263d' : '#777777' })
  await chrome.action.setBadgeText({ text: enabled ? '' : 'off' })
}

/* Per-tab log, serialised so concurrent messages don't overwrite each other */
let logging = Promise.resolve()
const updateTab = (tabId, change) => {
  logging = logging
    .then(async () => {
      const key = `tab:${tabId}`
      const { [key]: entry = { page: 0, recent: [] } } = await chrome.storage.session.get(key)
      const next = change(entry)
      if (next) await chrome.storage.session.set({ [key]: next })
      else await chrome.storage.session.remove(key)
    })
    .catch(() => {})
  return logging
}

const remember = (tabId, item) =>
  updateTab(tabId, entry => ({
    ...entry,
    page: entry.page + (item.layer === 'page' ? 1 : 0),
    recent: [{ ...item, at: Date.now() }, ...entry.recent].slice(0, RECENT_LIMIT)
  }))

chrome.runtime.onInstalled.addListener(() => sync())
chrome.runtime.onStartup.addListener(() => sync())

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'blocked') {
    const tabId = sender.tab && sender.tab.id
    if (tabId == null || tabId < 0) return false
    remember(tabId, { layer: 'page', url: message.url, reason: message.reason, via: message.via }).then(async () => {
      if (ACTION_COUNT) return dnr.setExtensionActionOptions({ tabUpdate: { tabId, increment: 1 } })
      const { [`tab:${tabId}`]: entry } = await chrome.storage.session.get(`tab:${tabId}`)
      return chrome.action.setBadgeText({ tabId, text: entry ? String(entry.page) : '' })
    }).catch(() => {})
    return false
  }
  if (message.type === 'popup:get') {
    popupState(message.tabId, message.host).then(sendResponse)
    return true
  }
  if (message.type === 'popup:set') {
    ;(async () => {
      const state = await getState()
      if ('enabled' in message) state.enabled = Boolean(message.enabled)
      if (message.pause) {
        const set = new Set(state.paused)
        if (message.pause.paused) set.add(message.pause.host)
        else set.delete(message.pause.host)
        state.paused = [...set].sort()
      }
      await chrome.storage.local.set(state)
      await sync()
      sendResponse(await popupState(message.tabId, message.pause && message.pause.host))
    })()
    return true
  }
  return false
})

const popupState = async (tabId, host) => {
  const { enabled, paused } = await getState()
  const key = `tab:${tabId}`
  const { [key]: entry = { page: 0, recent: [] } } = await chrome.storage.session.get(key)
  let network = 0
  try {
    const { rulesMatchedInfo } = await dnr.getMatchedRules({ tabId })
    network = rulesMatchedInfo.filter(
      info => info.rule.rulesetId === RULESET && !STATIC_ALLOW_RULES.has(info.rule.ruleId)
    ).length
  } catch (error) {
    // getMatchedRules is unavailable or over quota
  }
  return {
    enabled,
    paused: Boolean(host && paused.includes(host)),
    pausedCount: paused.length,
    network,
    page: entry.page,
    recent: entry.recent
  }
}

/* A new document in the tab starts a new log (Chrome resets the action count itself). */
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url) updateTab(tabId, () => null)
})
chrome.tabs.onRemoved.addListener(tabId => updateTab(tabId, () => null))

/* Unpacked builds can see which URLs the network rules blocked; packed builds only get counts. */
if (dnr.onRuleMatchedDebug) {
  dnr.onRuleMatchedDebug.addListener(({ request, rule }) => {
    if (request.tabId < 0 || rule.rulesetId !== RULESET || STATIC_ALLOW_RULES.has(rule.ruleId)) return
    remember(request.tabId, { layer: 'network', url: request.url.slice(0, 300), reason: `rule ${rule.ruleId}`, via: request.type })
  })
}
