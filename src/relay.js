/* PostHog Blocker, relay: forwards what the page layer (inject.js, MAIN world) blocked to the background,
   which adds it to the tab's badge. The detail is a JSON string, so it crosses worlds in Chrome and Firefox. */
document.addEventListener('posthog-blocker:blocked', event => {
  try {
    const { url, reason, via } = JSON.parse(event.detail)
    chrome.runtime.sendMessage({ type: 'blocked', url, reason, via }).catch(() => {})
  } catch (error) {
    // a page sent something else under our event name
  }
})
