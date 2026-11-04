/* Renders icons/icon.svg to the PNG sizes the manifest uses (transparent background). */
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const svg = await readFile(new URL('../icons/icon.svg', import.meta.url), 'utf8')
const browser = await chromium.launch()
const page = await browser.newPage()
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`
  )
  await page.screenshot({ path: new URL(`../icons/icon-${size}.png`, import.meta.url).pathname, omitBackground: true })
}
await browser.close()
console.log('icons/icon-{16,32,48,128}.png')
