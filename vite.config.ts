import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Where the site is served from.
 *
 * A GitHub Pages *project* site lives under the repository name —
 * https://<owner>.github.io/jarvis/ — not at the domain root. Vite assumes the
 * root, so every asset URL it emits is absolute (`/assets/index-abc.js`) and
 * resolves to https://<owner>.github.io/assets/… instead, which 404s. The
 * symptom is a blank page and a devtools console full of missing files.
 *
 * `/` locally is correct and must stay: the dev server and `npm run preview`
 * serve from the root. So the subpath is taken from an environment variable
 * rather than being hardcoded, and defaults to `/`.
 *
 * Anything that builds for Pages has to pass it — the workflow does, from its
 * own repository name so a renamed fork still deploys correctly. Setting
 * `base` by hand for an experiment:
 *
 *     VITE_BASE=/jarvis/ npm run build && npx vite preview
 */
const base = process.env.VITE_BASE || '/'

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [react()],
  server: {
    // Honour PORT so a second instance can run alongside the first. The bridge
    // only accepts sockets from localhost:5173-5199, so stay inside that range
    // or set JARVIS_ALLOWED_ORIGINS to match.
    port: Number(process.env.PORT) || 5173,
  },
  optimizeDeps: {
    // kokoro-js pulls in `phonemizer`, which carries espeak-ng as inline WASM.
    // Vite's dependency pre-bundler rewrites that initialisation and the
    // language table ends up empty — the symptom is
    // `Invalid language identifier: "en". Should be one of: .` at generate()
    // time, long after the model has loaded successfully. Serving these
    // untouched fixes it.
    exclude: ['kokoro-js', 'phonemizer', '@huggingface/transformers'],
  },
})
