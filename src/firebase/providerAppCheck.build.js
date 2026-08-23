/**
 * Default production builds deliberately omit the App Check SDK. The live
 * assisted-insights build replaces this fail-closed module through Vite's
 * build-time alias.
 */
export async function initializeProviderAppCheckAndVerify() {
  return false;
}
