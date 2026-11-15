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

/**
 * Resolve how this build reaches the Claude API, at build time.
 *
 * This is deliberately a `define` rather than a plain runtime read of
 * `import.meta.env`, and the difference is not stylistic. A GitHub Pages build
 * is pinned to `direct` because Pages cannot serve /api/anthropic, and
 * deploy.yml fails the build if that route string ends up in the artifact —
 * which it did, because the expression that derives the proxy URL was evaluated
 * at runtime and so could not be folded away, even in a build that never uses
 * it. Defining the value as a literal lets the bundler see
 * `'direct' === 'proxy'` and delete the branch, so the string is genuinely
 * absent rather than merely unreachable.
 *
 * The precedence matches src/config.ts: an explicit route wins, otherwise the
 * presence of a key selects direct, otherwise proxy — the mode that works when
 * someone deploys this without reading the code.
 */
const apiRoute =
  process.env.VITE_API_ROUTE === 'proxy' || process.env.VITE_API_ROUTE === 'direct'
    ? process.env.VITE_API_ROUTE
    : process.env.VITE_ANTHROPIC_API_KEY?.trim()
      ? 'direct'
      : 'proxy'

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [react()],
  define: {
    __JARVIS_API_ROUTE__: JSON.stringify(apiRoute),
    // Same treatment, same reason: a `direct` build on Pages must not contain
    // the string `/api/gemini` either. See the note above apiRoute.
    __JARVIS_PROVIDER__: JSON.stringify(
      process.env.VITE_PROVIDER === 'gemini' ? 'gemini' : 'anthropic',
    ),
  },
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
