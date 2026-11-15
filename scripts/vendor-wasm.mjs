#!/usr/bin/env node
/**
 * Put MediaPipe's WebAssembly where the page can actually load it.
 *
 * Hand tracking needs a WASM runtime, and the usual recipe fetches it from a
 * CDN. That fails here twice over. The page's CSP names no CDN in `script-src`,
 * and the runtime arrives as a script — so it is blocked, and the failure
 * surfaces as gesture control simply never starting. And a CDN import is a live
 * supply-chain dependency: executable code, re-resolved on every load, that we
 * do not control and cannot pin against being changed under us.
 *
 * Copying it out of node_modules solves both. It is served from our own origin,
 * so `'self'` covers it; and it is the exact bytes of the version in the
 * lockfile.
 *
 * It stays out of git — 34 MB of build output does not belong in a repository —
 * so this runs as part of the build as well as before `npm start`. A missing
 * @mediapipe package is not an error: gesture control is optional, and the app
 * carries on without it.
 *
 * Run directly (`npm run vendor:wasm`) to refresh it; both entry points are
 * idempotent, so a second run costs nothing.
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs'

const FROM = 'node_modules/@mediapipe/tasks-vision/wasm'
const TO = 'public/mediapipe'

export function vendorWasm() {
  if (!existsSync(FROM)) {
    // Only warn when someone asked for it explicitly; as part of a build this
    // is a normal state (a browser-only install may not carry the package).
    console.warn('[jarvis] @mediapipe/tasks-vision is not installed — gesture control will be unavailable.')
    return false
  }
  if (existsSync(`${TO}/vision_wasm_internal.wasm`)) return true
  try {
    mkdirSync(TO, { recursive: true })
    cpSync(FROM, TO, { recursive: true })
    console.log('  vendored the hand-tracking runtime into public/mediapipe.')
    return true
  } catch (err) {
    console.warn(`  could not vendor the hand-tracking runtime: ${err.message}`)
    return false
  }
}

// `node scripts/vendor-wasm.mjs` — run when invoked directly, stay quiet when
// imported.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  vendorWasm()
}
