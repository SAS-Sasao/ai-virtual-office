---
name: adapter-layout-algorithm
description: cc-sier-adapter のレイアウト自動生成アルゴリズムの具体定数と、それらが実装判断（設計メモ非規定）である旨
metadata:
  type: project
---

設計メモ（M1-3 rev.2）は「グリッド幅 30 タイル固定・行優先・部屋サイズはロール数比例・受付は最下段」までしか規定しておらず、具体的な数値（部屋の高さ・幅の係数・デスク間隔）は決めていなかった。`packages/cc-sier-adapter/src/import-org.ts` で以下の定数として実装判断した:

```
GRID_COLS = 30       // 固定（要件どおり）
ROOM_HEIGHT = 6       // 全部屋共通の高さ（タイル）
ROOM_GAP = 1          // 部屋間の隙間
ROOM_MIN_WIDTH = 5    // ロール 0 人の部屋でも確保する最低幅
WIDTH_PER_ROLE = 3    // 部屋幅 = max(ROOM_MIN_WIDTH, WIDTH_PER_ROLE * roleCount + 2)
DESK_SPACING = 3      // デスク同士の間隔（WIDTH_PER_ROLE と揃えてあり、通常は部屋内に収まる）
RECEPTION_ID = "dept-secretary"  // 受付部署の判定はこの id のハードコード（実データ 3 組織すべてで一致）
RECEPTION_HEIGHT = 5
DEFAULT_TILE_SIZE = 32
```

受付（`dept-secretary`）は他の部署を行優先で配置し終えた後、必ず最下段に幅 GRID_COLS 全幅で 1 部屋だけ追加する。実データで検証済み（jutaku-dev-team: 5 部署が 2 行に収まり、6 部署目の秘書室が 3 行目に来る）。

これらの数値は将来（M1-4a の描画実装や M2 のレイアウトエディタ）で見た目の都合上チューニングされる可能性が高い。**変更しても構わない**（設計メモが縛っているのは grid.cols=30 固定・行優先・custom 温存・decisiveness（乱数/時刻を含めない）のみ）。変更する場合は `import-org.test.ts` の「重ならない」「GRID_COLS 内に収まる」アサーションが引き続き通ることを確認すること。

キャラクター ID は `${org}:${roleId}` で組織をまたいだ一意性を確保している（[[masters_format_variance]] にある通り、同じロール ID が複数組織に実在するため、org 修飾なしでは characters.json 内で ID 衝突する）。
