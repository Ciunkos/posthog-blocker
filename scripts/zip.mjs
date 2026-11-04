/* Packs the files the browser needs into dist/posthog-blocker-<version>.zip (Chrome Web Store / AMO upload). */
import { readFile, mkdir, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const { version } = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'))
const out = `dist/posthog-blocker-${version}.zip`
await mkdir(new URL('../dist', import.meta.url), { recursive: true })
await rm(new URL(`../${out}`, import.meta.url), { force: true })
execFileSync('zip', ['-r', '-X', out, 'manifest.json', 'LICENSE', 'rules', 'src', 'popup', 'icons', '-x', 'icons/icon.svg'], {
  cwd: root,
  stdio: 'inherit'
})
console.log(out)
