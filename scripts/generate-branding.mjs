// Generates Kissd ReEdit branding assets:
//  - build/icon.png        (1024 square app icon: red Kissd wordmark on dark rounded square)
//  - public/favicon.png    (256 favicon for the browser tab in dev/web)
//  - public/splash.png     (startup splash, copied from SPLASH_SRC)
//  - public/splash.jpg     (jpg fallback for splash.html)
// dist/ copies are written too when dist/ exists, so an already-built app updates immediately.
// Run: node scripts/generate-branding.mjs
import sharp from 'sharp'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, copyFileSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SPLASH_SRC = 'F:/Downloads/ChatGPT Image May 27, 2026, 10_06_59 PM.png'

const DARK = '#0a0a0b'        // matches splash.html + window backgroundColor
const ICON_SIZE = 1024
const RADIUS = 184            // ~18% rounded corners, matches old icon style
const LOGO_WIDTH = 780        // wordmark width inside the square (~76%)

// kissd-logo.svg aspect ratio (viewBox 391.82 x 203.88)
const LOGO_AR = 391.82 / 203.88

async function buildIcon() {
  const logoH = Math.round(LOGO_WIDTH / LOGO_AR)
  const left = Math.round((ICON_SIZE - LOGO_WIDTH) / 2)
  const top = Math.round((ICON_SIZE - logoH) / 2)

  // Dark rounded-square background (transparent outside the radius).
  const bg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE}" height="${ICON_SIZE}">` +
      `<rect width="${ICON_SIZE}" height="${ICON_SIZE}" rx="${RADIUS}" ry="${RADIUS}" fill="${DARK}"/>` +
      `</svg>`
  )

  // Render the wordmark crisply via high density, then resize to target width.
  const logo = await sharp(join(root, 'public/kissd-logo.svg'), { density: 600 })
    .resize({ width: LOGO_WIDTH })
    .png()
    .toBuffer()

  await sharp(bg)
    .composite([{ input: logo, left, top }])
    .png()
    .toFile(join(root, 'build/icon.png'))

  console.log('build/icon.png written')
}

async function buildFavicon() {
  const fav = await sharp(join(root, 'build/icon.png')).resize(256, 256).png().toBuffer()
  await sharp(fav).toFile(join(root, 'public/favicon.png'))
  if (existsSync(join(root, 'dist'))) await sharp(fav).toFile(join(root, 'dist/favicon.png'))
  console.log('favicon.png written')
}

async function buildSplash() {
  if (!existsSync(SPLASH_SRC)) {
    console.warn('SPLASH_SRC not found, skipping splash:', SPLASH_SRC)
    return
  }
  const targets = [join(root, 'public')]
  if (existsSync(join(root, 'dist'))) targets.push(join(root, 'dist'))
  for (const dir of targets) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    copyFileSync(SPLASH_SRC, join(dir, 'splash.png'))
    // jpg fallback so splash.html never falls back to old branding
    await sharp(SPLASH_SRC).jpeg({ quality: 92 }).toFile(join(dir, 'splash.jpg'))
  }
  console.log('splash.png + splash.jpg written to', targets.length, 'dir(s)')
}

await buildIcon()
await buildFavicon()
await buildSplash()
console.log('done')
