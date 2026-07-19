# 開発環境準備ガイド（AI 指示書）

| 項目 | 内容 |
|------|------|
| ドキュメント種別 | 環境構築指示書（Claude Code に渡して実行させる前提の指示ベース） |
| 実測日 | 2026-07-19（§5 のスナップショット時点。**指示実行時は必ず再実測すること**） |
| 対象環境 | WSL2（Ubuntu 22.04）+ nvm。他環境では §1〜§3 の確認コマンドを同様に適用する |
| 根拠文書 | [要件定義 v0.2.1](./design/requirements.md)（NFR-2/4/5、§5、§9）/ [アーキテクチャ設計](./design/architecture-design.md) §4 技術スタック / [ループエンジニアリング設計書 v0.2](./design/loop-engineering-design.md) §2 |

---

## 0. AI への実行指示（この文書の使い方）

この文書は「人間向けの手順書」ではなく、**Claude Code への指示書**である。環境を検証・構築するときは以下のルールで上から順に実行せよ:

1. 各項目の**「確認」コマンドを先に実行**し、期待結果と一致したら何もしない（導入済みのものを再導入・更新しない）
2. 不一致のときだけ「導入」の指示を実行する
3. **`sudo` を要する操作・対話認証（`gh auth login` 等）・外部アカウント作成は AI が実行しない**。ユーザーに `! <コマンド>` 形式で依頼して停止する
4. グローバル環境（`~/.bashrc`、nvm、corepack 等）を変更したら、変更内容を必ず報告に含める
5. §5 のスナップショットは実測日時点の状態であり、**現在の状態の保証ではない**。再実測した結果だけを根拠にする
6. **マイルストーンを先取りして導入しない**（M1 の分は M1 着手時に §3 を実行する）。検証信号が無いまま環境だけ揃えることを避ける（設計書 §6 と同じ思想）
7. 全項目の確認後、`bash .claude/skills/office-verify/scripts/verify.sh` を実行し **exit 0** であることをもって完了とする

---

## 1. 共通基盤（マイルストーン非依存・開発の前提）

| # | 項目 | 要求 | 根拠 | 確認コマンド | 期待結果 |
|---|---|---|---|---|---|
| 1-1 | Node.js | **20 以上** | NFR-5 / AR-2 | `node --version` | `v20.x` 以上 |
| 1-2 | pnpm | **9.0.0**（corepack 経由） | AR-2 / ルート package.json `packageManager` | `pnpm --version` | `9.0.0` |
| 1-3 | git + gh（認証済み） | PR ワークフローに必須 | 設計書 §3.4 Phase 5（branch → PR → auto-merge） | `gh auth status` | `Logged in to github.com` |
| 1-4 | jq | 検証 hooks が使用 | 設計書 §2.2（無いと hooks がフェイルオープンし**検証信号が消える**） | `command -v jq` | パスが返る |
| 1-5 | curl | 観測 hooks の送信手段 | NFR-2 / 要件定義 §5.2 | `command -v curl` | パスが返る |
| 1-6 | Claude Code | 開発ハーネス本体 | 要件定義 §5.4 | `claude --version` | バージョンが返る |
| 1-7 | ワークスペース依存 | インストール済み | — | `pnpm install` | exit 0 |

**不一致時の導入指示**:

- **1-1**: `nvm install --lts && nvm use --lts`（nvm が無い環境では導入方法をユーザーに確認する）
- **1-2**: `corepack enable && corepack prepare pnpm@9.0.0 --activate`。**`npm install -g pnpm` は使わない**（`packageManager` 固定と競合する）。pnpm から「Update available 11.x」の案内が出ても**更新しない**（バージョンは package.json が正）
- **1-3**: `gh auth login` は対話認証のため AI は実行せず、ユーザーに `! gh auth login` を依頼する
- **1-4 / 1-5**: `sudo apt-get install -y jq curl` — sudo のためユーザーに依頼する
- **1-6**: 導入・更新はユーザー判断。AI からは依頼のみ

---

## 2. M0: PoC で追加が必要なもの

M0 は Next.js 単体構成（hooks → `/api/ingest` 直接 POST → SSE → 最小描画。アーキ設計 §10）。**追加のシステムツールは不要**で、以下の確認のみ行う:

| # | 項目 | 指示 |
|---|---|---|
| 2-1 | ポート 3000 / 4100 | `ss -tln \| grep -E ':(3000\|4100)'` で空きを確認。**実測時点で 3000 は別プロセスが LISTEN 中**だった。M0 着手時に占有していたら、占有プロセスをユーザーに確認してから解放を依頼するか、`next dev -p 3001` で回避する（勝手に kill しない）。4100 は Relay 用（M1 から使用） |
| 2-2 | ブラウザ確認手段 | WSL2 のため、動作確認は Windows 側ブラウザから `http://localhost:3000`（WSL2 の localhost フォワーディング）で行う。AI 自身の確認は curl での HTTP レスポンス検証 + （導入後は）Playwright を使う |
| 2-3 | npm パッケージ | Next.js 15 / React 19 / TypeScript / Zod は**環境準備ではなく M0 実装タスクの一部**として `pnpm add` する（ここでは導入しない）。追加後は `.claude/hooks/verify/typecheck-touched.sh` の骨格スキップが自動的に解除され、実型検査が有効化されることに注意 |

補足: App Router で SSE が buffering されないことの検証（アーキ設計 §9）は環境準備ではなく **M0 の最初の実装検証タスク**である。

---

## 3. M1: ローカル α で追加が必要なもの

**M1 着手時にこの節を実行する**（先取りしない）:

| # | 項目 | 指示 | 根拠 |
|---|---|---|---|
| 3-1 | ネイティブビルド環境 | better-sqlite3 の prebuild が Node バージョンに無い場合 node-gyp ビルドが走る。`command -v gcc g++ make python3` がすべて返ることを確認（実測: 導入済み）。欠けていたら `sudo apt-get install -y build-essential` をユーザーに依頼 | アーキ設計 §4（SQLite: better-sqlite3 / Drizzle） |
| 3-2 | Playwright ブラウザ | `pnpm exec playwright install chromium` を実行（**未導入**・実測でブラウザキャッシュなし）。WSL のシステム依存ライブラリが不足する場合は `sudo pnpm exec playwright install-deps chromium` をユーザーに依頼 | 設計書 §5（E2E は Playwright + Debug State API） |
| 3-3 | settings.json の playwright permission | `.claude/settings.json` の `permissions.allow` に `"Bash(pnpm exec playwright *)"` を追加（M0 着手前セットで意図的に除外した分。設計書 §2.1） | 設計書 §2.1 |
| 3-4 | `~/.ai-office/config.json` | **未作成**。要件定義 §5.3 の形式で作成し、`organizations` に cc-sier リポジトリを登録する: `{ "organizations": [{ "repo": "/home/toyoki05/cc-sier-organization", "type": "cc-sier" }], "forward": { "url": null, "token": null } }` | 要件定義 §5.3（FR-4 の cwd 帰属の有効化条件） |
| 3-5 | cc-sier-organization リポジトリ | `ls /home/toyoki05/cc-sier-organization/.companies/` に `domain-tech-collection` が存在することを確認（実測: 3 組織あり）。M1 受入基準「domain-tech-collection のマスタから 3 部署の間取りが生成」の入力データ | 要件定義 §1.4 / §9 M1 |
| 3-6 | sqlite3 CLI（任意） | DB の目視デバッグ用。必須ではない（better-sqlite3 は自前バイナリを持つ）。入れる場合は `sudo apt-get install -y sqlite3` をユーザーに依頼 | — |

vitest / better-sqlite3 / drizzle / playwright 本体の npm パッケージは、3-1〜3-2 と同じく **M1 実装タスクの一部**として `pnpm add` する。

---

## 4. M2 / M3: 現時点で導入しないもの

| MS | 必要になるもの | AI への指示 |
|---|---|---|
| M2 | 追加なし（task-log リプレイは cc-sier リポジトリの読み取りのみ。transcript フォールバックは `~/.claude/projects/` の読み取りのみ） | 何も導入しない |
| M3 | Vercel アカウント + CLI / Postgres（Neon・Supabase 等）/ Supabase Realtime | **アカウント作成・サービス選定・課金判断は人間タスク**。AI は M3 着手時に選定結果を確認してから CLI 導入を提案する。それまで一切導入しない |

---

## 5. 実測スナップショット(2026-07-19)

再実測の起点として残す。**信用せず、必ず §1〜§3 の確認コマンドで再実測すること**:

| 項目 | 実測結果 | 状態 | 対応時期 |
|---|---|---|---|
| OS | WSL2 / Ubuntu 22.04.5 LTS | — | — |
| Node.js | v24.16.0（nvm） | ✅ NFR-5 充足 | — |
| pnpm | 9.0.0（corepack で有効化済み） | ✅ | — |
| git / gh | 2.34.1 / 2.94.0、SAS-Sasao で認証済み | ✅ | — |
| jq / curl | 1.6 / 7.81.0 | ✅ | — |
| Claude Code | 2.1.215 | ✅ | — |
| gcc / g++ / make / python3 | 11.4.0 / 11.4.0 / 4.3 / 3.12.13 | ✅（3-1 前提済み） | — |
| pnpm install | 成功（lockfile コミット済み、骨格のため importers 空） | ✅ | — |
| ポート 3000 | **別プロセスが LISTEN 中** | ⚠️ | M0 着手時に 2-1 を実行 |
| ポート 4100 | 空き | ✅ | — |
| Playwright ブラウザ | 導入済み（chromium-1228 / headless_shell-1228 / ffmpeg-1011。WSL 依存ライブラリ libnss3 / libnspr4 / libasound2 も apt 導入済み、ヘッドレス起動テスト PASS。2026-07-19 §3 前倒し実行） | ✅ | — |
| `~/.ai-office/config.json` | 作成済み（cc-sier-organization を登録、forward は null） | ✅ | — |
| cc-sier-organization | `/home/toyoki05/cc-sier-organization` に 3 組織あり（domain-tech-collection / jutaku-dev-team / standardization-initiative） | ✅ | — |
| sqlite3 CLI | 導入済み（3.37.2） | ✅ | — |

---

## 6. 完了条件

- §1 の全 7 項目が期待結果と一致している
- 現在のマイルストーンに対応する節（M0 なら §2、M1 なら §3）の指示がすべて完了している
- `bash .claude/skills/office-verify/scripts/verify.sh` が **exit 0** で終了する
- 実行した導入・変更の一覧（何もしなかった項目は「確認のみ」）を報告する
