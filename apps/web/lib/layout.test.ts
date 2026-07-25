import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOfficeLayoutData, resolveLayoutsDir } from "./layout";

/**
 * M1-4a: `/api/layout` が読む office-layout.json / characters.json のロード
 * ヘルパー。並行作業（org-adapter-dev）で `packages/protocol` の `RoomSchema`
 * に `door: {x, y}` が必須フィールドとして追加される予定（破壊的変更）。
 * このファイルの fixture は先行して door 付きで書く（設計メモ rev.2）。
 * `door` を含む assertion は、その変更が protocol に landed してビルドされる
 * までは red のままになる想定（依存未着地による red であり実装バグではない）。
 */

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ai-office-web-layout-test-"));
}

function validLayoutJson(): string {
  return JSON.stringify({
    version: 1,
    floors: [
      {
        org: "domain-tech-collection",
        label: "domain-tech-collection",
        grid: { cols: 30, rows: 20, tileSize: 24 },
        rooms: [
          {
            id: "dept-research",
            name: "Research",
            status: "active",
            x: 2,
            y: 2,
            w: 6,
            h: 5,
            triggers: ["tech-researcher"],
            door: { x: 4, y: 6 },
          },
        ],
        furniture: [{ kind: "desk", x: 3, y: 3 }],
      },
    ],
  });
}

function validCharactersJson(): string {
  return JSON.stringify([
    {
      id: "char-1",
      name: "Researcher",
      role: "tech-researcher",
      dept: "dept-research",
      org: "domain-tech-collection",
    },
  ]);
}

describe("resolveLayoutsDir", () => {
  it("AI_OFFICE_LAYOUTS_DIR が設定されていればそれを使う", () => {
    const dir = resolveLayoutsDir({ AI_OFFICE_LAYOUTS_DIR: "/custom/layouts" } as unknown as NodeJS.ProcessEnv);
    expect(dir).toBe("/custom/layouts");
  });

  it("未設定なら既定の ~/.ai-office/layouts にフォールバックする", () => {
    const dir = resolveLayoutsDir({} as unknown as NodeJS.ProcessEnv);
    expect(dir.endsWith(join(".ai-office", "layouts"))).toBe(true);
    expect(dir).not.toBe(join(".ai-office", "layouts"));
  });
});

describe("loadOfficeLayoutData", () => {
  let dir: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("有効な office-layout.json / characters.json を protocol スキーマで parse して返す", () => {
    dir = makeTmpDir();
    writeFileSync(join(dir, "office-layout.json"), validLayoutJson(), "utf-8");
    writeFileSync(join(dir, "characters.json"), validCharactersJson(), "utf-8");

    const result = loadOfficeLayoutData(dir);

    expect(result.layout).not.toBeNull();
    expect(result.layout?.version).toBe(1);
    expect(result.layout?.floors).toHaveLength(1);
    const room = result.layout?.floors[0].rooms[0];
    expect(room).toMatchObject({
      id: "dept-research",
      name: "Research",
      status: "active",
      x: 2,
      y: 2,
      w: 6,
      h: 5,
      triggers: ["tech-researcher"],
    });
    expect(result.characters).toEqual([
      {
        id: "char-1",
        name: "Researcher",
        role: "tech-researcher",
        dept: "dept-research",
        org: "domain-tech-collection",
      },
    ]);
  });

  it("room.door が末端まで保持される（protocol の door 必須化後に green になる想定）", () => {
    dir = makeTmpDir();
    writeFileSync(join(dir, "office-layout.json"), validLayoutJson(), "utf-8");
    writeFileSync(join(dir, "characters.json"), validCharactersJson(), "utf-8");

    const result = loadOfficeLayoutData(dir);

    expect(result.layout?.floors[0].rooms[0]).toMatchObject({ door: { x: 4, y: 6 } });
  });

  it("office-layout.json が存在しない場合、null/[] を返し 例外を投げない", () => {
    dir = makeTmpDir();
    writeFileSync(join(dir, "characters.json"), validCharactersJson(), "utf-8");

    const result = loadOfficeLayoutData(dir);

    expect(result).toEqual({ layout: null, characters: [] });
  });

  it("characters.json が存在しない場合も null/[] を返す", () => {
    dir = makeTmpDir();
    writeFileSync(join(dir, "office-layout.json"), validLayoutJson(), "utf-8");

    const result = loadOfficeLayoutData(dir);

    expect(result).toEqual({ layout: null, characters: [] });
  });

  it("ディレクトリごと存在しない場合も null/[] を返す（未インポート環境）", () => {
    const result = loadOfficeLayoutData("/no/such/ai-office-layouts-dir");

    expect(result).toEqual({ layout: null, characters: [] });
  });

  it("office-layout.json が不正な JSON の場合、null/[] を返す", () => {
    dir = makeTmpDir();
    writeFileSync(join(dir, "office-layout.json"), "{not valid json", "utf-8");
    writeFileSync(join(dir, "characters.json"), validCharactersJson(), "utf-8");

    const result = loadOfficeLayoutData(dir);

    expect(result).toEqual({ layout: null, characters: [] });
  });

  it("office-layout.json がスキーマ不一致（型違反）の場合、null/[] を返す", () => {
    dir = makeTmpDir();
    const invalid = JSON.stringify({ version: 1, floors: [{ org: "o", label: "o", grid: { cols: "not-a-number", rows: 1, tileSize: 1 }, rooms: [], furniture: [] }] });
    writeFileSync(join(dir, "office-layout.json"), invalid, "utf-8");
    writeFileSync(join(dir, "characters.json"), validCharactersJson(), "utf-8");

    const result = loadOfficeLayoutData(dir);

    expect(result).toEqual({ layout: null, characters: [] });
  });

  it("旧形式（room に door が無い）の office-layout.json は parse 失敗として null/[] を返す（door 必須化後に green になる想定）", () => {
    dir = makeTmpDir();
    const oldFormat = JSON.stringify({
      version: 1,
      floors: [
        {
          org: "domain-tech-collection",
          label: "domain-tech-collection",
          grid: { cols: 30, rows: 20, tileSize: 24 },
          rooms: [
            {
              id: "dept-research",
              name: "Research",
              status: "active",
              x: 2,
              y: 2,
              w: 6,
              h: 5,
              triggers: ["tech-researcher"],
            },
          ],
          furniture: [],
        },
      ],
    });
    writeFileSync(join(dir, "office-layout.json"), oldFormat, "utf-8");
    writeFileSync(join(dir, "characters.json"), validCharactersJson(), "utf-8");

    const result = loadOfficeLayoutData(dir);

    expect(result).toEqual({ layout: null, characters: [] });
  });

  it("characters.json がスキーマ不一致（必須フィールド欠落）の場合、null/[] を返す", () => {
    dir = makeTmpDir();
    writeFileSync(join(dir, "office-layout.json"), validLayoutJson(), "utf-8");
    const invalidCharacters = JSON.stringify([{ id: "char-1", name: "Researcher" }]);
    writeFileSync(join(dir, "characters.json"), invalidCharacters, "utf-8");

    const result = loadOfficeLayoutData(dir);

    expect(result).toEqual({ layout: null, characters: [] });
  });

  it("いずれの異常系でも console.warn は1回だけ呼ばれ、既定ロガーとして機能する", () => {
    dir = makeTmpDir();
    // characters.json を欠落させて異常系を発生させる
    writeFileSync(join(dir, "office-layout.json"), validLayoutJson(), "utf-8");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    loadOfficeLayoutData(dir);

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("機微非漏洩: 異常系の警告ログにファイル内容やディレクトリのフルパスが含まれない（NFR-4 準拠の配慮）", () => {
    dir = makeTmpDir();
    writeFileSync(join(dir, "office-layout.json"), "{not valid json, sensitive-marker-xyz", "utf-8");
    writeFileSync(join(dir, "characters.json"), validCharactersJson(), "utf-8");

    const warnMessages: string[] = [];
    loadOfficeLayoutData(dir, { warn: (message) => warnMessages.push(message) });

    expect(warnMessages).toHaveLength(1);
    expect(warnMessages[0]).not.toContain("sensitive-marker-xyz");
    expect(warnMessages[0]).not.toContain(dir);
  });

  it("readFileSync を注入できる（DI）", () => {
    const files = new Map<string, string>([
      ["/injected/office-layout.json", validLayoutJson()],
      ["/injected/characters.json", validCharactersJson()],
    ]);
    const readFileSync = (path: string): string => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    };

    const result = loadOfficeLayoutData("/injected", { readFileSync });

    expect(result.layout).not.toBeNull();
    expect(result.characters).toHaveLength(1);
  });
});
