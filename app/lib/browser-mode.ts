export const browserModelEnabled =
  process.env.NEXT_PUBLIC_BROWSER_MODEL === "1";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const browserModelBaseUrl =
  process.env.NEXT_PUBLIC_MODEL_BASE_URL ??
  `${basePath.replace(/\/app$/, "")}/model`;
