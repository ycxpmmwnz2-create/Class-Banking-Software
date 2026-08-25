import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import { resolveFirebaseBuildConfiguration } from './src/firebase/firebaseConfig.js'

export const FIREBASE_FUNCTIONS_PRECONNECT_MARKER = '<!-- VITE_FIREBASE_FUNCTIONS_PRECONNECT -->'

export function createFirebaseFunctionsPreconnectPlugin(firebaseProjectId) {
  const functionsOrigin = `https://us-central1-${firebaseProjectId}.cloudfunctions.net`

  return {
    name: 'firebase-functions-preconnect',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const occurrences = html.split(FIREBASE_FUNCTIONS_PRECONNECT_MARKER).length - 1
        if (occurrences !== 1) {
          throw new Error(
            `Firebase Functions preconnect marker must appear exactly once (found ${occurrences}).`,
          )
        }
        return html.replace(
          FIREBASE_FUNCTIONS_PRECONNECT_MARKER,
          `<link rel="preconnect" href="${functionsOrigin}" crossorigin />`,
        )
      },
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const repositoryRoot = fileURLToPath(new URL('.', import.meta.url))
  const buildEnvironment = loadEnv(mode, repositoryRoot, 'VITE_')
  const resolvedFirebaseBuild = resolveFirebaseBuildConfiguration(buildEnvironment)
  const providerAppCheckAlias = buildEnvironment.VITE_VERSION3_GEMINI_LIVE === 'true'
    ? {
        './providerAppCheck.build.js': fileURLToPath(
          new URL('./src/firebase/providerAppCheck.js', import.meta.url),
        ),
      }
    : {}

  return {
    plugins: [
      createFirebaseFunctionsPreconnectPlugin(resolvedFirebaseBuild.firebaseConfig.projectId),
    ],
    resolve: {
      alias: providerAppCheckAlias,
    },
  }
})
