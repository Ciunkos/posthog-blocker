# PostHog Blocker ⛔🦔

A browser extension that stops PostHog analytics on every site, so your own visits stop showing up in your PostHog
project. It works like an ad blocker. It also stops the cases the usual filter lists miss: first-party proxies
(`/ingest`, `/ph`, made-up paths), SDKs served from the site's own domain, and `posthog-js` bundled into app code.

The PostHog app (`*.posthog.com` pages) keeps working.

## How it works

1. **Network rules** (`rules/posthog.json`, declarativeNetRequest):
   - `*.i.posthog.com` and `app.posthog.com`;
   - SDK files under any host: `array.js`, the recorders, `posthog*.js`, `posthog-js@…`, `/vendor/posthog/`;
   - URLs carrying a project key (`phc_…`);
   - ingestion and flags endpoints behind any proxy, recognised by PostHog's own query string (`compression=gzip-js`, `_=<ms>`, `ver=`, `retry_count=`, `/flags/?v=`);
   - the common proxy prefixes (`/ingest/`, `/ph/`, `/_ph/`, `/posthog/`…).

   A higher-priority allow rule keeps the posthog.com app and its own requests untouched.
2. **Page layer** (`src/inject.js`, the page's main world, before any page script):
   - `window.posthog` is a locked, inert stub. The official snippet and loaders that check `__SV` never add the SDK. Calls do nothing, feature flags read as off, and `onFeatureFlags` callbacks get empty flags.
   - `fetch`, `XMLHttpRequest` and `sendBeacon` drop PostHog requests. A request is dropped when its URL matches the rules above or when its body carries a project key, so this works on any path. The page gets a fake `200 {}` back, which stops the SDK from retrying.
   - Scripts carrying the SRI hash of a known PostHog build are turned into inert `text/plain` scripts before the browser fetches or runs them, whatever they are called (`<script src="/assets/a1b2.js" integrity="sha384-…">`). This works whether the script is in the HTML or added from JS. The list (`src/sri-hashes.js`) covers:
     - sha256 of the `array*.js` and recorder builds of every posthog-js release from the last year;
     - sha384 and sha512 of the main builds from the last 90 days;
     - the ciunkos.com vendored builds.

     `npm run sri` refreshes it, and `.github/workflows/sri.yml` does that weekly. Browsers can't block a request by hash, so this check runs in the page.
3. **Popup**:
   - a global switch;
   - a per-site pause, for checking your own analytics;
   - what was blocked in the current tab. The URL list for network blocks only shows in unpacked installs, because packed builds only get counts.

The badge shows how many requests were blocked on the tab, by both layers.

## Install locally

- **Chrome, Edge, Brave**: open `chrome://extensions`, enable Developer mode, click **Load unpacked** and pick this folder.
- **Firefox 128+**: open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…** and pick `manifest.json`. Then go to `about:addons`, open PostHog Blocker → Permissions and allow access to all websites. Firefox has no network-block count, so the badge shows only page-layer blocks there.

## Develop

```sh
npm install           # Playwright and posthog-js, dev only (.npmrc: releases at least 7 days old)
npm test              # rules + page-layer matchers against the same URL fixtures
npm run test:e2e      # Chromium with the extension, fixture pages, the real posthog-js module
npm run icons         # icons/icon.svg → PNGs
npm run sri           # refresh src/sri-hashes.js from new posthog-js releases (cached in data/sri.json)
npm run zip           # dist/posthog-blocker-<version>.zip for store uploads
```

The URL patterns live twice, as RE2 regexes in `rules/posthog.json` and as JS regexes in `src/inject.js`. `npm test`
checks both against one list of URLs that must be blocked and URLs that must load.

## Limits

- Server-side events (posthog-node, Workers, backend `capture` calls) never pass through the browser.
- A proxy can still get through, but only if it renames every endpoint, strips PostHog's query string and sends
  compressed bodies. The page layer then has nothing to recognise.
- SRI matching only helps when a page uses `integrity`, and only for unmodified PostHog builds. A custom bundle, like the
  one ciunkos.com builds, needs its hash added (`OWN_BUILDS` in `scripts/sri-hashes.mjs`).
- The page layer is visible to page scripts (wrapped `fetch`, `setAttribute` and `integrity`, a locked `window.posthog`).
  It adds about 120 KB of hash list to each frame.

## Credits

Host and path rules were checked against PostHog entries in
[EasyPrivacy](https://easylist.to/) and [AdGuard Tracking Protection](https://github.com/AdguardTeam/AdguardFilters).
Not affiliated with PostHog Inc.

## License

MIT, © 2026 Przemysław Zalewski
