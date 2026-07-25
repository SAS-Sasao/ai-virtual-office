import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as layoutLib from "../../../lib/layout";
import { GET } from "./route";

/**
 * `GET /api/layout` の結線テスト。ファイル読み取り・スキーマ検証そのものの
 * 詳細ケースは `lib/layout.test.ts`（`loadOfficeLayoutData`）で網羅済みのため、
 * ここでは「実ディレクトリに対して 200 + 期待した形の JSON を返す」「異常系でも
 * 落ちずに 200 + null/[] を返す」という route レベルの契約のみを確認する。
 *
 * `lib/layout.ts` の `resolveLayoutsDir` を `vi.spyOn` で差し替えて一時
 * ディレクトリへ向ける（named import でも spy が効くことは m1-3 で確認済み。
 * `AI_OFFICE_LAYOUTS_DIR` の直接的な process.env 書き換えは他テストへの汚染
 * リスクがあるため避ける）。
 */

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
          {
            id: "reception",
            name: "Reception",
            status: "active",
            x: 10,
            y: 2,
            w: 4,
            h: 3,
            triggers: [],
            door: { x: 11, y: 4 },
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
    {
      id: "char-2",
      name: "Secretary",
      role: "dept-secretary",
      dept: "reception",
      org: "domain-tech-collection",
    },
  ]);
}

describe("GET /api/layout", () => {
  let dir: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("有効な layout/characters が置かれたディレクトリから 200 + parse 済み内容を返す（3 フロア相当の縮約 fixture: 2 部屋・2 キャラ）", async () => {
    dir = mkdtempSync(join(tmpdir(), "ai-office-web-api-layout-test-"));
    writeFileSync(join(dir, "office-layout.json"), validLayoutJson(), "utf-8");
    writeFileSync(join(dir, "characters.json"), validCharactersJson(), "utf-8");
    vi.spyOn(layoutLib, "resolveLayoutsDir").mockReturnValue(dir);

    const res = await GET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.layout.version).toBe(1);
    expect(body.layout.floors).toHaveLength(1);
    expect(body.layout.floors[0].rooms).toHaveLength(2);
    expect(body.layout.floors[0].rooms[0].door).toEqual({ x: 4, y: 6 });
    expect(body.layout.floors[0].rooms[1].door).toEqual({ x: 11, y: 4 });
    expect(body.characters).toHaveLength(2);
    expect(body.characters[0]).toEqual({
      id: "char-1",
      name: "Researcher",
      role: "tech-researcher",
      dept: "dept-research",
      org: "domain-tech-collection",
    });
  });

  it("ディレクトリが存在しない（未インポート環境）場合、200 + {layout: null, characters: []} を返す", async () => {
    vi.spyOn(layoutLib, "resolveLayoutsDir").mockReturnValue("/no/such/ai-office-layouts-dir");

    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ layout: null, characters: [] });
  });

  it("office-layout.json が不正な JSON の場合でも 200 + {layout: null, characters: []} を返す（例外を投げない）", async () => {
    dir = mkdtempSync(join(tmpdir(), "ai-office-web-api-layout-test-"));
    writeFileSync(join(dir, "office-layout.json"), "{not valid json", "utf-8");
    writeFileSync(join(dir, "characters.json"), validCharactersJson(), "utf-8");
    vi.spyOn(layoutLib, "resolveLayoutsDir").mockReturnValue(dir);

    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ layout: null, characters: [] });
  });

  it("door の無い旧形式 office-layout.json の場合、200 + {layout: null, characters: []} を返す（スキーマ不一致）", async () => {
    dir = mkdtempSync(join(tmpdir(), "ai-office-web-api-layout-test-"));
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
    vi.spyOn(layoutLib, "resolveLayoutsDir").mockReturnValue(dir);

    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ layout: null, characters: [] });
  });

  it("機微非漏洩: 異常系での console.warn にファイル内容・ディレクトリのフルパスが含まれない", async () => {
    dir = mkdtempSync(join(tmpdir(), "ai-office-web-api-layout-test-"));
    writeFileSync(join(dir, "office-layout.json"), "{not valid json, secret-token-abc123", "utf-8");
    writeFileSync(join(dir, "characters.json"), validCharactersJson(), "utf-8");
    vi.spyOn(layoutLib, "resolveLayoutsDir").mockReturnValue(dir);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await GET();
    expect(res.status).toBe(200);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message] = warnSpy.mock.calls[0] as [string];
    expect(message).not.toContain("secret-token-abc123");
    expect(message).not.toContain(dir);
  });
});
