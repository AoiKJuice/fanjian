import { describe, expect, it } from "vitest";
import {
  parseProfileBackup,
  serializeProfileBackup,
} from "../app/lib/profile-backup";

describe("profile backup", () => {
  it("imports a file exported by the settings page", () => {
    const payload = serializeProfileBackup(
      {
        id: 7,
        name: "旧资料",
        title_language: "native",
        rating_count: 2,
        updated_at: "2026-08-03T00:00:00.000Z",
      },
      [
        {
          mal_id: 1,
          rating: 9,
          status: "completed",
          updated_at: "2026-08-03T00:00:00.000Z",
        },
        {
          mal_id: 2,
          rating: null,
          status: "plan_to_watch",
          updated_at: "2026-08-03T00:00:00.000Z",
        },
      ],
    );

    const parsed = parseProfileBackup(payload);
    expect(parsed.name).toBe("旧资料");
    expect(parsed.titleLanguage).toBe("native");
    expect(parsed.preview.imported).toBe(2);
    expect(parsed.preview.unrated).toBe(1);
    expect(parsed.preview.items).toEqual([
      { mal_id: 1, rating: 9, status: "completed" },
      { mal_id: 2, rating: null, status: "plan_to_watch" },
    ]);
  });

  it("accepts earlier exports without schema_version", () => {
    const parsed = parseProfileBackup(JSON.stringify({
      exported_at: "2026-08-01T00:00:00.000Z",
      profile: { name: "原导出", title_language: "zh" },
      ratings: [{ mal_id: 5114, rating: 10, status: "completed" }],
    }));

    expect(parsed.name).toBe("原导出");
    expect(parsed.preview.items).toHaveLength(1);
  });

  it("rejects unrelated JSON files", () => {
    expect(() => parseProfileBackup('{"items":[]}')).toThrow(
      "这不是番鉴导出的资料文件",
    );
  });
});
