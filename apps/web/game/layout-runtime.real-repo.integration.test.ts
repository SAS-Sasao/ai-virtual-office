// AC-3b②（game 統合）: 実 cc-sier-adapter CLI（ビルド済み dist/cli.js）を
// サブプロセスとして実行して得た実 office-layout.json / characters.json を
// layout-runtime.buildRuntimeLayout + pathfinding.findPath に通し、実 3 フロア
// すべてで「入口 → 全 active 部屋」の到達可能性を検証する。
//
// Phase 3 レビュー指摘 2（low）への対応: door タイルへの到達だけでは
// 「door は visited だが内部は角に阻まれて閉じている」ケースを見逃す
// （packages/cc-sier-adapter/src/import-org.ts の checkFloorConnectivity 側で
// 同種の穴を interiorAnchor 導入で塞いだのと対になる、game 側の実測）。
// door 宛の findPath に加えて、各部屋の内部代表タイル（roomInteriorAnchor）と、
// 実際にキャラが配置されるデスク座標（deskByCharacterId）への findPath 成功も
// 併せて assert する。
//
// AC-3b①（adapter 側の生成時不変条件）は cc-sier-adapter の
// import-org.test.ts / real-repo.integration.test.ts が担当し、本ファイルの対象では
// ない（設計メモの層分け通り）。ここでは「adapter が実際に書き出した office-layout.json
// を game 側のロジックにそのまま通しても壁抜け・ドア推測ずれが起きない」ことを検証する。
//
// 実リポジトリ（/home/toyoki05/cc-sier-organization）が無い環境（通常の CI 等）では
// describe.skip にフォールバックする（cc-sier-adapter/src/real-repo.integration.test.ts
// と同じ設計判断。テスト弱体化ではなく外部リソースの実在チェック）。出力は必ず一時
// ディレクトリへ書き、実リポジトリ・`~/.ai-office/` のいずれも変更しない。
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CharacterSchema, OfficeLayoutSchema } from "@ai-office/protocol";
import { z } from "zod";
import { findPath } from "./pathfinding";
import { buildRuntimeLayout, roomInteriorAnchor } from "./layout-runtime";

const REAL_REPO = "/home/toyoki05/cc-sier-organization";
const ADAPTER_CLI = join(__dirname, "..", "..", "..", "packages", "cc-sier-adapter", "dist", "cli.js");
const hasRealRepo = existsSync(join(REAL_REPO, ".companies"));
const hasBuiltCli = existsSync(ADAPTER_CLI);

const CharacterArraySchema = z.array(CharacterSchema);

const workDirs: string[] = [];
afterEach(() => {
  while (workDirs.length > 0) {
    const dir = workDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

(hasRealRepo && hasBuiltCli ? describe : describe.skip)(
  "AC-3b: real cc-sier-adapter CLI output is fully walkable (entrance -> every active room)",
  () => {
    it("every active room in every real floor is reachable from the entrance via layout-runtime + pathfinding", () => {
      const outDir = mkdtempSync(join(tmpdir(), "ai-office-game-ac3b-out-"));
      workDirs.push(outDir);

      execFileSync(process.execPath, [ADAPTER_CLI, "import", "--repo", REAL_REPO, "--out", outDir], {
        encoding: "utf-8",
      });

      const layoutRaw = JSON.parse(readFileSync(join(outDir, "office-layout.json"), "utf-8"));
      const charactersRaw = JSON.parse(readFileSync(join(outDir, "characters.json"), "utf-8"));

      const layout = OfficeLayoutSchema.parse(layoutRaw);
      const characters = CharacterArraySchema.parse(charactersRaw);

      // 実測: 3 組織すべてが揃っていること（AC-2 の実測と同じ期待値）
      expect(layout.floors.map((f) => f.org).sort()).toEqual([
        "domain-tech-collection",
        "jutaku-dev-team",
        "standardization-initiative",
      ]);

      const runtime = buildRuntimeLayout(layout, characters);
      expect(runtime.floors).toHaveLength(3);

      for (const runtimeFloor of runtime.floors) {
        const activeRooms = runtimeFloor.floor.rooms.filter((r) => r.status === "active");
        expect(activeRooms.length).toBeGreaterThan(0);

        for (const room of activeRooms) {
          const doorPath = findPath(runtimeFloor.walkGrid, runtimeFloor.entrance, room.door);
          expect(
            doorPath,
            `org "${runtimeFloor.floor.org}" room "${room.id}" should be reachable from the entrance (door ${JSON.stringify(room.door)})`,
          ).not.toBeNull();

          // door 到達だけでなく、部屋の内部代表タイルへも実際に歩いて辿り着けること
          // （door が角に来て内部が閉じているケースを door 到達だけでは見逃すため）。
          const anchor = roomInteriorAnchor(room);
          const anchorPath = findPath(runtimeFloor.walkGrid, runtimeFloor.entrance, anchor);
          expect(
            anchorPath,
            `org "${runtimeFloor.floor.org}" room "${room.id}" interior anchor ${JSON.stringify(anchor)} should be reachable from the entrance`,
          ).not.toBeNull();
        }

        // 実際にキャラが配置されるデスク座標へも、入口から歩いて辿り着けること。
        for (const [characterId, desk] of runtimeFloor.deskByCharacterId) {
          const deskPath = findPath(runtimeFloor.walkGrid, runtimeFloor.entrance, desk);
          expect(
            deskPath,
            `org "${runtimeFloor.floor.org}" character "${characterId}" desk ${JSON.stringify(desk)} should be reachable from the entrance`,
          ).not.toBeNull();
        }
      }
    });
  },
);
