import { expect, test } from "@playwright/test";

const viewports = [
  { name: "360x800", width: 360, height: 800 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1920x1080", width: 1920, height: 1080 },
];

test("dashboard visual baselines and overflow", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "visual baselines run once");
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    await page.goto("/dashboard");
    await expect(page.getByText("989203", { exact: true })).toBeVisible();
    await expect(page.locator("h1")).toContainText("本地资料");
    const hasOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(hasOverflow).toBe(false);
    await expect(page).toHaveScreenshot(`dashboard-${viewport.name}.png`, {
      fullPage: true,
      animations: "disabled",
    });
  }
});

test("dark recommendation baseline", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "visual baselines run once");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/recommendations");
  await expect(page.getByRole("heading", { name: "评分资料不足" })).toBeVisible();
  await page.evaluate(() => {
    localStorage.setItem("anime-theme", "dark");
    document.documentElement.dataset.theme = "dark";
  });
  await expect(page).toHaveScreenshot("recommendations-dark-1440x900.png", {
    fullPage: true,
    animations: "disabled",
  });
});
