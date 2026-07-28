"use client";

import {
  Books,
  ChartDonut,
  ClockCounterClockwise,
  Gear,
  House,
  Infinity,
  MagnifyingGlass,
  Moon,
  Sparkle,
  Sun,
  UserCircle,
} from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { loadProfiles } from "../lib/api";
import { useTheme } from "../providers";
import { LocalModelGate } from "./local-model-gate";

const nav = [
  { href: "/dashboard", label: "概览", icon: House },
  { href: "/recommendations", label: "推荐", icon: Sparkle },
  { href: "/library", label: "片库", icon: Books },
  { href: "/insights", label: "审美分析", icon: ChartDonut },
  { href: "/history", label: "历史", icon: ClockCounterClockwise },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { theme, toggleTheme } = useTheme();
  const profilesQuery = useQuery({
    queryKey: ["profiles"],
    queryFn: loadProfiles,
  });
  const profileName = profilesQuery.data?.[0]?.name ?? "本地资料";

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = new FormData(event.currentTarget).get("q");
    if (query) router.push(`/library?q=${encodeURIComponent(String(query))}`);
  }

  return (
    <div className="app-shell">
      <LocalModelGate />
      <aside className="side-nav">
        <Link href="/dashboard" className="brand" aria-label="番鉴首页">
          <span className="brand-mark" aria-hidden>
            <Infinity size={42} weight="thin" />
          </span>
          <span className="brand-wordmark">
            <strong>番鉴</strong>
          </span>
        </Link>
        <nav aria-label="主导航">
          {nav.map((item) => {
            const active =
              pathname === item.href ||
              (item.href !== "/dashboard" && pathname.startsWith(item.href));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={active ? "active" : ""}
                aria-current={active ? "page" : undefined}
              >
                <item.icon size={20} weight={active ? "fill" : "regular"} />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="side-footer">
          <Link href="/settings">
            <Gear size={19} />
            设置
          </Link>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <form className="global-search" role="search" onSubmit={search}>
            <MagnifyingGlass size={19} aria-hidden />
            <input name="q" placeholder="搜索番剧、原名或 MAL ID" aria-label="全局番剧搜索" />
          </form>
          <div className="topbar-actions">
            <button
              className="icon-button"
              onClick={toggleTheme}
              aria-label={theme === "light" ? "切换到深色主题" : "切换到浅色主题"}
            >
              {theme === "light" ? <Moon size={20} /> : <Sun size={20} />}
            </button>
            <Link
              className="profile-switcher"
              href="/settings"
              aria-label={`当前资料${profileName}，打开设置`}
            >
              <UserCircle size={23} weight="duotone" />
              <span>{profileName}</span>
            </Link>
          </div>
        </header>
        <main id="main-content">{children}</main>
      </div>

      <nav className="bottom-nav" aria-label="手机主导航">
        {nav.map((item) => {
          const active =
            pathname === item.href ||
            (item.href !== "/dashboard" && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={active ? "active" : ""}
              aria-current={active ? "page" : undefined}
            >
              <item.icon size={21} weight={active ? "fill" : "regular"} />
              <span>{item.label === "审美分析" ? "分析" : item.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
