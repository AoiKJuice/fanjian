"use client";

import {
  Books,
  CaretDown,
  ChartDonut,
  Check,
  ClockCounterClockwise,
  Gear,
  House,
  Infinity,
  Moon,
  Sparkle,
  Sun,
  UserCircle,
} from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Popover } from "radix-ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { loadProfiles } from "../lib/api";
import {
  selectActiveProfile,
  useActiveProfile,
  useTheme,
} from "../providers";
import { GlobalCatalogSearch } from "./catalog-add";
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
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const { theme, toggleTheme } = useTheme();
  const profilesQuery = useQuery({
    queryKey: ["profiles"],
    queryFn: loadProfiles,
  });
  const profile = useActiveProfile(profilesQuery.data);
  const profileId = profile?.id;
  const profileName = profile?.name ?? "本地资料";

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
          <GlobalCatalogSearch profileId={profileId} />
          <div className="topbar-actions">
            <button
              className="icon-button"
              onClick={toggleTheme}
              aria-label={theme === "light" ? "切换到深色主题" : "切换到浅色主题"}
            >
              {theme === "light" ? <Moon size={20} /> : <Sun size={20} />}
            </button>
            <Popover.Root
              open={profileMenuOpen}
              onOpenChange={setProfileMenuOpen}
            >
              <Popover.Trigger asChild>
                <button
                  className="profile-switcher"
                  aria-label={`当前资料${profileName}，切换资料`}
                >
                  <UserCircle size={23} weight="duotone" />
                  <span>{profileName}</span>
                  <CaretDown size={14} weight="bold" aria-hidden />
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  className="profile-menu"
                  align="end"
                  sideOffset={8}
                  collisionPadding={12}
                >
                  <strong className="profile-menu-title">切换资料</strong>
                  <div className="profile-menu-list">
                    {profilesQuery.data?.map((item) => {
                      const active = item.id === profileId;
                      return (
                        <button
                          key={item.id}
                          className={active ? "active" : ""}
                          aria-pressed={active}
                          onClick={() => {
                            selectActiveProfile(item.id);
                            setProfileMenuOpen(false);
                          }}
                        >
                          <span className="profile-menu-avatar">
                            {item.name.slice(0, 1)}
                          </span>
                          <strong>{item.name}</strong>
                          {active && <Check size={17} weight="bold" />}
                        </button>
                      );
                    })}
                  </div>
                  <Link
                    className="profile-menu-manage"
                    href="/settings"
                    onClick={() => setProfileMenuOpen(false)}
                  >
                    管理本地资料
                  </Link>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
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
