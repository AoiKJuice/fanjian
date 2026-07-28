import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const metadata: Metadata = {
  title: "番鉴 | 评分亲和度研究室",
  description: "从评分结构中寻找真正相近的观众，生成可解释的番剧推荐。",
  icons: {
    icon: `${basePath}/favicon.svg`,
    shortcut: `${basePath}/favicon.svg`,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-CN"
      data-product="anime-affinity-lab"
      suppressHydrationWarning
    >
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
