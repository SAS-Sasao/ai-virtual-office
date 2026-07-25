---
name: adapter-layout-algorithm
description: cc-sier-adapter のレイアウト自動生成アルゴリズムの具体定数・連結性保証（M1-4a rev.2）と、それらが実装判断（設計メモ非規定）である旨
metadata:
  type: project
---

設計メモ（M1-3 rev.2）は「グリッド幅 30 タイル固定・行優先・部屋サイズはロール数比例・受付は最下段」までしか規定しておらず、具体的な数値（部屋の高さ・幅の係数・デスク間隔）は決めていなかった。`packages/cc-sier-adapter/src/import-org.ts` で以下の定数として実装判断した:

```
GRID_COLS = 30          // 固定（要件どおり）
CORRIDOR_MARGIN = 1      // フロア外周・部屋の行間に確保する廊下レーン幅（M1-4a rev.2 で追加）
ROOM_HEIGHT = 6          // 全部屋共通の高さ（タイル）
ROOM_GAP = 1             // 同一行内で隣り合う部屋どうしの間隔
ROOM_MIN_WIDTH = 5       // ロール 0 人の部屋でも確保する最低幅
WIDTH_PER_ROLE = 3       // 部屋幅 = max(ROOM_MIN_WIDTH, WIDTH_PER_ROLE * roleCount + 2)
DESK_SPACING = 3         // デスク同士の間隔（WIDTH_PER_ROLE と揃えてあり、通常は部屋内に収まる）
RECEPTION_ID = "dept-secretary"  // 受付部署の判定はこの id のハードコード（実データ 3 組織すべてで一致）
RECEPTION_HEIGHT = 5
DEFAULT_TILE_SIZE = 32
```

これらの数値は将来（M1-4a の描画実装や M2 のレイアウトエディタ）で見た目の都合上チューニングされる可能性が高い。**変更しても構わない**（設計メモが縛っているのは grid.cols=30 固定・行優先・custom 温存・decisiveness（乱数/時刻を含めない）+ M1-4a rev.2 で追加された「外周・行間 1 タイルの廊下レーン」「受付は他部屋と同じ比例幅で全幅にしない」「door は必須フィールド」「生成時の連結性不変条件」のみ）。変更する場合は `import-org.test.ts` の非重なり・GRID_COLS 内・**連結性（checkFloorConnectivity）**アサーションが引き続き通ることを確認すること。

## M1-4a rev.2: 連結性保証（廊下レーン + door 契約 + 生成時不変条件）

**背景（F1）**: 旧アルゴリズム（部屋を隙間なく敷き詰め + 受付フロア全幅）は、歩行モデル（部屋境界=壁・door のみ通行可）と組むと受付以外の全部屋が入口から到達不能になることが実測で判明した。対応は 3 点セット:

1. **廊下レーン**: `roomsGeometry` の配置で `cursorX`/`cursorY` の初期値・折返し境界を `CORRIDOR_MARGIN`（外周 1 タイル）分だけ内側にオフセットする。同一行内の部屋間は既存の `ROOM_GAP` がそのまま廊下として機能する（1 行の高さ分のみ）。行と行の間（`ROOM_HEIGHT + ROOM_GAP` で改行）も同じ `ROOM_GAP` が全幅の廊下行になる。**この「行間ギャップ行が常に全幅で部屋に一切占有されない」という構築規則が連結性の要（左右マージン列 x=0 と x=GRID_COLS-1 は常に全部屋の外側にあるため、上下マージン行・行間ギャップ行と合わせて「額縁」状に全域連結する）**。
2. **受付の脱・全幅化**: `dept-secretary` も他部署と同じ `roomWidthFor(roleCount)` を使い、`receptionX = CORRIDOR_MARGIN + floor((availableWidth - receptionWidth) / 2)` で水平中央寄せする（`availableWidth = GRID_COLS - 2*CORRIDOR_MARGIN`）。常に最下段の行に単独配置する点は旧仕様を維持。
3. **door フィールド**（`packages/protocol` の `RoomSchema.door: {x,y}` 必須・破壊的変更）: `computeDoor(room, allRooms)` が部屋の下辺（`y = room.y + room.h - 1`）のうち、中央優先で「直下 (x, y+1) がどの部屋にも属さない（廊下）」タイルを探索して返す。フォールバック（中央固定）は理論上到達しない防御コード——構築規則を守っている限り、行間ギャップ行が必ず廊下なので中央がそのまま採用される。
4. **生成時不変条件**: `checkFloorConnectivity(floor)`（`import-org.ts` からエクスポート）が入口（`x=floor(cols/2), y=rows-1` の最下段中央タイル）から 4 近傍 BFS を行い、各 **active** 部屋の door タイルへ到達できるかを検証する（door に到達できれば door に隣接する interior タイルにも自動的に到達するため、door 到達判定のみで内部到達を代表させてよい——interior は矩形なので自明に全域連結）。**standby 部屋は判定対象外**（描画側の「ドア閉鎖」演出は生成時の連結性契約に含めない）。`buildOrgFloor` は Floor 組み立て直後にこれを呼び、`ok:false` なら該当 org の warnings に到達不能な部屋 id を列挙して生成を中断する（他 org は道連れにしない。既存出力は上書きしない——`cli.ts` 側の「1 org 失敗→除外」経路をそのまま再利用）。

**実測（2026-07-25、実リポジトリに対する実 import + 独立実装の BFS スクリプトで二重検証）**: 3 組織すべてが GRID_COLS=30 に収まり、全 active 部屋が到達可能、受付幅は全て 5（GRID_COLS=30 に対して非全幅）。

```
domain-tech-collection      grid.rows=14  (research w5, retail w5, secretary w5)
jutaku-dev-team              grid.rows=28  (pm w5, architecture w8, development w14, quality w11, infra w8, secretary w5)
standardization-initiative   grid.rows=14  (pm w5, secretary w5)
```

**このアルゴリズムの重要な性質（今後の変更時に注意）**: 左マージン列（x=0）は部屋配置ロジック上どんな入力（ロール数がどれだけ偏っても）でも絶対に占有されない設計になっている。そのため部屋の横幅が異常に大きくなって右マージンを侵食しても（本来はバグ）、左マージン経由の縦方向連結路は生き残り、`checkFloorConnectivity` が実際には発火しにくい。したがって**この不変条件テストは「実際に起きたバグ」ではなく「将来のアルゴリズム変更に対する回帰防止の安全網」として機能する**（`import-org.test.ts` の `checkFloorConnectivity` describe ブロックは意図的に手作りの壊れた Floor で負ケースをテストしている。`buildOrgFloor` からの自然な負ケース誘発は現実的な入力では再現できなかった）。

## fixtures/masters.ts に 3 組織すべての実マスタが揃った（M1-4a で追加）

従来は `domain-tech-collection` のみ実マスタ写しだった。M1-4a の AC-3b（3 実組織すべてでの連結性検証を fixture ベースで行う）のため、`ORGANIZATION_MD_JUTAKU` / `DEPARTMENTS_MD_JUTAKU` / `ROLES_MD_JUTAKU`（6 部署・13 ロール）と `ORGANIZATION_MD_STANDARDIZATION` / `DEPARTMENTS_MD_STANDARDIZATION` / `ROLES_MD_STANDARDIZATION`（2 部署・2 ロール）を追加した（2026-07-25 実測の書き写し）。今後 3 組織全体を使う fixture ベーステストが必要になったら、実リポジトリに依存せずこれらを再利用できる。

キャラクター ID は `${org}:${roleId}` で組織をまたいだ一意性を確保している（[[masters_format_variance]] にある通り、同じロール ID が複数組織に実在するため、org 修飾なしでは characters.json 内で ID 衝突する）。
