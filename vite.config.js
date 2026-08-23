import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const repositoryRoot = fileURLToPath(new URL('.', import.meta.url))
  const buildEnvironment = loadEnv(mode, repositoryRoot, 'VITE_')
  const providerAppCheckAlias = buildEnvironment.VITE_VERSION3_GEMINI_LIVE === 'true'
    ? {
        './providerAppCheck.build.js': fileURLToPath(
          new URL('./src/firebase/providerAppCheck.js', import.meta.url),
        ),
      }
    : {}

  return {
    plugins: [],
    resolve: {
      alias: providerAppCheckAlias,
    },
  }
})
