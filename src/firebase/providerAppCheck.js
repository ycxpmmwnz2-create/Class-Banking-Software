import {
  getLimitedUseToken,
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from "firebase/app-check";

/**
 * Initializes App Check and proves that this build can obtain the same
 * limited-use token type required by the live Gemini callable.
 */
export async function initializeProviderAppCheckAndVerify({
  app,
  siteKey,
  initializeAppCheckFn = initializeAppCheck,
  createProvider = key => new ReCaptchaEnterpriseProvider(key),
  getLimitedUseTokenFn = getLimitedUseToken,
} = {}) {
  if (!app || typeof app !== "object") {
    throw new TypeError("A Firebase app is required for provider App Check.");
  }
  if (
    typeof siteKey !== "string"
    || siteKey.length < 20
    || siteKey.length > 256
    || siteKey.trim() !== siteKey
  ) {
    throw new TypeError("A canonical App Check site key is required.");
  }
  if (
    typeof initializeAppCheckFn !== "function"
    || typeof createProvider !== "function"
    || typeof getLimitedUseTokenFn !== "function"
  ) {
    throw new TypeError("Provider App Check dependencies are unavailable.");
  }

  const appCheck = initializeAppCheckFn(app, {
    provider: createProvider(siteKey),
    isTokenAutoRefreshEnabled: true,
  });
  const tokenResult = await getLimitedUseTokenFn(appCheck);
  if (
    !tokenResult
    || typeof tokenResult.token !== "string"
    || tokenResult.token.length < 1
    || tokenResult.token.trim() !== tokenResult.token
  ) {
    throw new TypeError("Provider App Check did not return a usable limited-use token.");
  }
  return true;
}
