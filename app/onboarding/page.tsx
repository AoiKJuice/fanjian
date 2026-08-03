"use client";

import {
  ArrowLeft,
  ArrowRight,
  Check,
  FileArrowUp,
  Infinity,
  ListChecks,
  MagnifyingGlass,
  Sparkle,
  UserCircle,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { AnimeCover } from "../components/anime-cover";
import { RatingControl } from "../components/rating-control";
import { ThemeSelect } from "../components/theme-select";
import {
  createProfile,
  importAniList,
  importBangumi,
  importMal,
  loadInsights,
  loadProfiles,
  saveRatings,
  searchAnime,
  type ImportPreview,
  type Insights,
  type Profile,
  type RatingItem,
} from "../lib/api";
import type { Anime } from "../lib/data";
import {
  parseProfileBackup,
  type ProfileBackupImport,
} from "../lib/profile-backup";
import { selectActiveProfile } from "../providers";

const steps = ["建立资料", "导入评分", "预览差异", "资料质量"];

export default function OnboardingPage() {
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const creatingNew = params.get("new") === "1";
  const [step, setStep] = useState(0);
  const [source, setSource] =
    useState<"anilist" | "bangumi" | "mal" | "fanjian" | "manual">("anilist");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState("我的资料");
  const [titleLanguage, setTitleLanguage] =
    useState<"zh" | "native" | "en">("zh");
  const [username, setUsername] = useState("");
  const [bangumiUsername, setBangumiUsername] = useState("");
  const [bangumiToken, setBangumiToken] = useState("");
  const [malFile, setMalFile] = useState<File | null>(null);
  const [backup, setBackup] = useState<ProfileBackupImport | null>(null);
  const [backupFileName, setBackupFileName] = useState("");
  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState<Anime[]>([]);
  const [rated, setRated] = useState<Record<number, number>>({});
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (creatingNew) return;
    loadProfiles()
      .then((profiles) => {
        const empty = profiles.find((item) => item.rating_count === 0);
        if (empty) {
          setProfile(empty);
          selectActiveProfile(empty.id);
          setName(empty.name);
          setTitleLanguage(
            empty.title_language === "native" || empty.title_language === "en"
              ? empty.title_language
              : "zh",
          );
        }
      })
      .catch((reason: Error) => setError(reason.message));
  }, [creatingNew]);

  async function ensureProfile() {
    if (profile) return profile;
    const created = await createProfile(name.trim() || "我的资料", titleLanguage);
    setProfile(created);
    selectActiveProfile(created.id);
    await queryClient.invalidateQueries({ queryKey: ["profiles"] });
    return created;
  }

  async function readBackup(file: File | null) {
    if (!file) return;
    setError("");
    try {
      const parsed = parseProfileBackup(await file.text());
      setBackup(parsed);
      setBackupFileName(file.name);
    } catch (reason) {
      setBackup(null);
      setBackupFileName("");
      setError(reason instanceof Error ? reason.message : "导入失败");
    }
  }

  async function search() {
    if (!searchText.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await searchAnime(searchText.trim(), 12);
      setSearchResults(result.items);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "搜索失败");
    } finally {
      setBusy(false);
    }
  }

  async function continueFlow() {
    setBusy(true);
    setError("");
    try {
      if (step === 0) {
        await ensureProfile();
        setStep(1);
        return;
      }
      if (step === 1) {
        const current = await ensureProfile();
        if (source === "anilist") {
          if (!username.trim()) throw new Error("请输入 AniList 用户名");
          setPreview(await importAniList(current.id, username.trim()));
        } else if (source === "bangumi") {
          if (!bangumiUsername.trim()) throw new Error("请输入 Bangumi 用户名");
          setPreview(
            await importBangumi(
              current.id,
              bangumiUsername.trim(),
              bangumiToken.trim(),
            ),
          );
        } else if (source === "mal") {
          if (!malFile) throw new Error("请选择 MAL XML 文件");
          setPreview(await importMal(current.id, malFile));
        } else if (source === "fanjian") {
          if (!backup) throw new Error("请选择番鉴导出的 JSON 文件");
          setPreview(backup.preview);
        } else {
          const items: RatingItem[] = Object.entries(rated).map(
            ([malId, rating]) => ({
              mal_id: Number(malId),
              rating,
              status: "completed",
            }),
          );
          if (!items.length) throw new Error("请至少为一部作品评分");
          setPreview({
            imported: items.length,
            unmapped: 0,
            duplicates: 0,
            unrated: 0,
            items,
            unmapped_items: [],
            warnings: [],
          });
        }
        setStep(2);
        return;
      }
      if (step === 2 && profile && preview) {
        await saveRatings(
          profile.id,
          preview.items,
          preview.unmapped_items,
        );
        await queryClient.invalidateQueries({ queryKey: ["profiles"] });
        setInsights(await loadInsights(profile.id));
        setStep(3);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="onboarding-shell">
      <header className="onboarding-header">
        <Link href="/dashboard" className="brand" aria-label="番鉴首页">
          <span className="brand-mark" aria-hidden>
            <Infinity size={42} weight="thin" />
          </span>
          <span className="brand-wordmark">
            <strong>番鉴</strong>
          </span>
        </Link>
      </header>
      <div className="onboarding-progress" aria-label="设置进度">
        {steps.map((label, index) => (
          <div key={label} className={index <= step ? "active" : ""}>
            <span>{index < step ? <Check size={14} /> : index + 1}</span>
            <strong>{label}</strong>
          </div>
        ))}
      </div>
      <main className="onboarding-main">
        {step === 0 && (
          <section className="onboarding-card">
            <UserCircle size={38} weight="duotone" />
            <p className="eyebrow">步骤 1 / 4</p>
            <h1>建立你的本地资料</h1>
            <label>
              资料名称
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <div className="onboarding-field">
              <span>标题显示</span>
              <ThemeSelect
                value={titleLanguage}
                ariaLabel="标题显示"
                options={[
                  { value: "zh", label: "简体中文优先" },
                  { value: "native", label: "原文优先" },
                  { value: "en", label: "英文优先" },
                ]}
                onValueChange={(value) =>
                  setTitleLanguage(value as "zh" | "native" | "en")
                }
              />
            </div>
          </section>
        )}
        {step === 1 && (
          <section className="onboarding-card wide">
            <FileArrowUp size={38} weight="duotone" />
            <p className="eyebrow">步骤 2 / 4</p>
            <h1>导入真实评分</h1>
            <div className="source-tabs">
              {[
                ["anilist", "AniList 用户名"],
                ["bangumi", "Bangumi 用户名"],
                ["mal", "MAL 文件"],
                ["fanjian", "番鉴文件"],
                ["manual", "手动评分"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  className={source === value ? "active" : ""}
                  onClick={() => setSource(value as typeof source)}
                >
                  {label}
                </button>
              ))}
            </div>
            {source === "anilist" && (
              <div className="source-panel">
                <label>
                  AniList 用户名
                  <input
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    placeholder="例如：your_name"
                  />
                </label>
              </div>
            )}
            {source === "mal" && (
              <div className="source-panel upload-box">
                <FileArrowUp size={28} />
                <strong>选择 MAL 导出的 XML 文件</strong>
                <input
                  type="file"
                  accept=".xml,text/xml,application/xml"
                  aria-label="选择 MAL XML 文件"
                  onChange={(event) => setMalFile(event.target.files?.[0] ?? null)}
                />
              </div>
            )}
            {source === "fanjian" && (
              <label className="source-panel upload-box profile-json-upload">
                <FileArrowUp size={28} />
                <strong>{backupFileName || "选择番鉴导出的 JSON 文件"}</strong>
                <input
                  type="file"
                  accept=".json,application/json"
                  aria-label="选择番鉴 JSON 文件"
                  onChange={(event) => void readBackup(event.target.files?.[0] ?? null)}
                />
              </label>
            )}
            {source === "bangumi" && (
              <div className="source-panel">
                <label>
                  Bangumi 用户名
                  <input
                    value={bangumiUsername}
                    onChange={(event) =>
                      setBangumiUsername(event.target.value)
                    }
                    placeholder="例如：your_name"
                  />
                </label>
                <label>
                  Access Token（私密收藏才需要）
                  <input
                    type="password"
                    value={bangumiToken}
                    onChange={(event) => setBangumiToken(event.target.value)}
                    autoComplete="off"
                  />
                </label>
              </div>
            )}
            {source === "manual" && (
              <>
                <div className="source-panel">
                  <label>
                    搜索完整番剧库
                    <span className="inline-search">
                      <MagnifyingGlass size={18} />
                      <input
                        value={searchText}
                        onChange={(event) => setSearchText(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void search();
                          }
                        }}
                        placeholder="中文、日文或英文标题"
                      />
                      <button className="button quiet" onClick={() => void search()}>
                        搜索
                      </button>
                    </span>
                  </label>
                </div>
                <div className="manual-grid">
                  {searchResults.map((item) => (
                    <article
                      key={item.mal_id}
                      className={rated[item.mal_id] ? "is-rated" : ""}
                    >
                      <AnimeCover
                        index={item.cover_index}
                        title={item.title_zh || item.title_native}
                        src={item.cover_url}
                      />
                      <h2>{item.title_zh || item.title_native}</h2>
                      <RatingControl
                        value={rated[item.mal_id] ?? null}
                        label={`${item.title_zh || item.title_native}评分`}
                        onChange={(rating) =>
                          setRated((current) => {
                            const next = { ...current };
                            if (rating == null) {
                              delete next[item.mal_id];
                            } else {
                              next[item.mal_id] = rating;
                            }
                            return next;
                          })
                        }
                      />
                    </article>
                  ))}
                </div>
              </>
            )}
          </section>
        )}
        {step === 2 && preview && (
          <section className="onboarding-card wide">
            <ListChecks size={38} weight="duotone" />
            <p className="eyebrow">步骤 3 / 4</p>
            <h1>确认导入结果</h1>
            <div className="import-stats">
              <div><strong>{preview.imported}</strong><span>可写入记录</span></div>
              <div><strong>{preview.unmapped}</strong><span>待关联（仍会导入）</span></div>
              <div><strong>{preview.unrated}</strong><span>未评分（仍会导入）</span></div>
              <div><strong>{preview.duplicates}</strong><span>重复记录</span></div>
            </div>
            {preview.warnings.map((warning) => (
              <p className="inline-note" key={warning}>{warning}</p>
            ))}
          </section>
        )}
        {step === 3 && insights && (
          <section className="onboarding-card quality-card">
            <Sparkle size={38} weight="duotone" />
            <p className="eyebrow">步骤 4 / 4</p>
            <h1>评分资料已写入</h1>
            <div className="quality-score">
              <strong>{insights.quality}</strong>
              <span>推荐资料质量</span>
            </div>
            <ul>
              <li><Check size={17} /> {insights.rating_count} 条有效评分</li>
              <li><Check size={17} /> 评分标准差 {insights.rating_stddev}</li>
              <li><Check size={17} /> 覆盖 {insights.distinct_integer_scores} 个整数评分区间</li>
            </ul>
          </section>
        )}
        {error && <p className="inline-note" role="alert">{error}</p>}
      </main>
      <footer className="onboarding-footer">
        <button
          className="button quiet"
          disabled={step === 0 || busy}
          onClick={() => setStep((current) => current - 1)}
        >
          <ArrowLeft size={18} /> 上一步
        </button>
        {step < 3 ? (
          <button
            className="button primary"
            disabled={busy}
            onClick={() => void continueFlow()}
          >
            {busy ? "处理中…" : step === 2 ? "确认写入" : "继续"}{" "}
            <ArrowRight size={18} />
          </button>
        ) : (
          <Link className="button primary" href="/recommendations">
            生成第一组推荐 <Sparkle size={18} />
          </Link>
        )}
      </footer>
    </div>
  );
}
