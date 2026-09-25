import { describe, expect, test } from "bun:test";
import { summaryExcerpt } from "../src/services/meetings";

describe("summaryExcerpt", () => {
  test("takes the paragraph under a Summary / 摘要 heading", () => {
    const md = "# Q4 規劃\n\n2026-09-24 · 42 分鐘\n\n## 摘要\n本次會議確認 **v2.3** 範圍，SSO 延到 v2.4。\n\n## 討論\n- 其他";
    expect(summaryExcerpt(md)).toBe("本次會議確認 v2.3 範圍，SSO 延到 v2.4。");
  });

  test("falls back to the first real paragraph, skipping a short metadata line", () => {
    const md = "# Title\n\nMon · 30 min\n\n## Discussion\nThe team reviewed the roadmap and agreed to ship the dashboard work first.";
    expect(summaryExcerpt(md)).toBe("The team reviewed the roadmap and agreed to ship the dashboard work first.");
  });

  test("uses bullet text for TL;DR lists and truncates long text", () => {
    const md = "## TL;DR\n- " + "字".repeat(300);
    const out = summaryExcerpt(md, 50)!;
    expect(out.length).toBe(50);
    expect(out.endsWith("…")).toBe(true);
  });

  test("ignores tables and returns null for empty content", () => {
    expect(summaryExcerpt("## 摘要\n| a | b |\n| - | - |")).toBeNull();
  });
});
