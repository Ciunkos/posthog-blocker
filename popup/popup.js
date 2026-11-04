/* PostHog Blocker popup: global switch, per-site pause, what was blocked in the current tab. */
const $ = id => document.getElementById(id)

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
let host = null
try {
  const url = new URL(tab.url)
  if (/^https?:$/.test(url.protocol)) host = url.hostname
} catch (error) {
  host = null
}

const render = state => {
  $('enabled').checked = state.enabled
  $('paused').checked = state.paused
  $('paused').disabled = !host || !state.enabled
  $('site-row').setAttribute('aria-disabled', String($('paused').disabled))
  $('host').textContent = host || 'this page'
  $('network').textContent = state.network
  $('page').textContent = state.page
  const list = $('recent')
  list.replaceChildren(
    ...state.recent.map(item => {
      const li = document.createElement('li')
      const em = document.createElement('em')
      em.textContent = `${item.layer}/${item.via} ${item.reason} `
      li.append(em, item.url)
      return li
    })
  )
  $('empty').hidden = state.recent.length > 0
}

const send = message => chrome.runtime.sendMessage({ tabId: tab.id, host, ...message })

render(await send({ type: 'popup:get' }))

const changed = state => {
  render(state)
  $('reload').hidden = false
}
$('enabled').addEventListener('change', async event => {
  changed(await send({ type: 'popup:set', enabled: event.target.checked }))
})
$('paused').addEventListener('change', async event => {
  changed(await send({ type: 'popup:set', pause: { host, paused: event.target.checked } }))
})
