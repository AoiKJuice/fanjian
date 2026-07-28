import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("manual onboarding searches the complete local catalog", async ({ page }) => {
  await page.goto("/onboarding");
  await expect(page.getByRole("heading", { name: "建立你的本地资料" })).toBeVisible();
  await page.getByRole("button", { name: "继续" }).click();
  await expect(page.getByRole("heading", { name: "导入真实评分" })).toBeVisible();
  await page.getByRole("button", { name: "手动评分" }).click();
  await page.getByPlaceholder("中文、日文或英文标题").fill("Frieren");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.getByText("Sousou no Frieren", { exact: true })).toBeVisible();
  await expect(page.getByText("Sousou no Frieren: Ougonkyou-hen", { exact: true })).toBeVisible();
});

test("insufficient profiles never receive fabricated recommendations", async ({ page }) => {
  await page.goto("/recommendations");
  await expect(page.getByRole("heading", { name: "评分资料不足" })).toBeVisible();
  await expect(page.getByText("至少录入 5 条有效评分后，系统才会运行真实邻居匹配。")).toBeVisible();
});

test("empty library presents a real import action", async ({ page }) => {
  await page.goto("/library");
  await expect(page.getByRole("heading", { name: "片库还是空的" })).toBeVisible();
  await expect(page.getByRole("link", { name: "导入评分" })).toHaveAttribute("href", "/onboarding");
});

test("core page has no serious accessibility violations", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByText("989203", { exact: true })).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter(
      (item) => item.impact === "serious" || item.impact === "critical",
    ),
  ).toEqual([]);
});
