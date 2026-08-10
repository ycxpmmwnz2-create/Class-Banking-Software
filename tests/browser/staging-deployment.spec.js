import { expect, test } from "@playwright/test";

test.skip(
  process.env.PHASE2B_STAGING_BROWSER !== "true",
  "Runs only through the isolated staging-browser contract command."
);

test("staging stays visibly labeled outside the application render root", async ({ page }) => {
  await page.goto("/");

  const banner = page.locator("#stagingDeploymentBanner");
  await expect(banner).toBeVisible();
  await expect(banner).toHaveText("TEST VERSION - USE FAKE DATA ONLY");
  await expect(page.locator("#app")).not.toBeEmpty();

  const placement = await page.evaluate(() => {
    const bannerElement = document.getElementById("stagingDeploymentBanner");
    const appElement = document.getElementById("app");
    return Boolean(
      bannerElement && appElement &&
      (bannerElement.compareDocumentPosition(appElement) & Node.DOCUMENT_POSITION_FOLLOWING)
    );
  });
  expect(placement).toBe(true);
});
