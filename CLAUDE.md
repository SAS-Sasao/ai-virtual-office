# ai-virtual-office

## プロジェクト概要

Claude Code のエージェント活動（複数セッション・サブエージェント・GitHub Actions 上のエージェント）を、CC-SIer 仮想組織の構造（組織 = フロア、部署 = 部屋、ロール = キャラクター）に基づくピクセルアート風オフィスとして可視化する Web アプリケーション。Claude Code hooks → Relay → ingest → Canvas 2D 描画のイベントパイプラインでライブ表示し、CC-SIer の task-log から過去活動をリプレイすることもできる。

## 設計の出自

このプロジェクトは `cc-sier-organization` リポジトリの組織「domain-tech-collection」でのリサーチ・設計作業からスポーンされた。設計の正本・トレーサビリティは `docs/design/origin.md` を参照。

**参考実装**: [pixel-agents](https://github.com/pixel-agents-hq/pixel-agents)（pixel-agents-hq）。イベント取得の二系統設計（hooks 主系 + `~/.claude/projects/**/*.jsonl` トランスクリプト保険系）、Canvas 2D + 自前ゲームループ、ツール名 → キャラ状態のマッピングという基本構造は同プロジェクトの分析から採用している。設計・実装で迷ったら、pixel-agents が同じ課題をどう解いているかを先に確認すること。ただし本アプリの差別化要素（CC-SIer マスタ駆動のオフィス生成 / task-log リプレイ / クラウド配信）は独自設計であり、コードの流用はしない（別実装として開発する）。

- 要件定義: `docs/design/requirements.md`
- アーキテクチャ設計: `docs/design/architecture-design.md`
- UI/UX モック（フロントモック v0.1）: `docs/design/ui/`（画面・配色・状態表現の参照仕様。正本は claude.ai/design プロジェクト、詳細は同ディレクトリ README）
- AWS 構成図（draw.io）: `docs/design/aws-architecture.drawio`
- AWS 構成図（CloudFormation 相当 YAML）: `docs/design/aws-architecture.cfn.yaml`
- ループエンジニアリング設計（検証 hooks / SKILL / E2E 自動化）: `docs/design/loop-engineering-design.md`（`.claude` 構成の実装は未着手。導入順序は同書 §6 を参照）

## 技術スタック

- TypeScript（全域）
- Next.js 15（App Router）+ React 19 — `apps/web`
- 素の Canvas 2D + 自前ゲームループ（Phaser/PixiJS 不使用）— `apps/web/game`
- Zod（イベントスキーマ正本）— `packages/protocol`
- Node 20+ 単体 CLI（Relay）— `packages/relay`
- pnpm workspaces（monorepo）

## 開発コマンド

現時点ではプレースホルダのみ（M0 PoC 未着手のため実装なし）。

```bash
pnpm dev     # TODO: apps/web の dev サーバ起動（M0 で実装予定）
pnpm build   # TODO: 全パッケージビルド（M0 で実装予定）
pnpm test    # TODO: vitest（protocol/relay/state-machine 対象、M1 で実装予定）
```

## リポジトリ構成

```
ai-virtual-office/
├── apps/
│   └── web/                    ← Next.js 15（UI + ingest/stream API）
│       └── game/                ← React 非依存のゲームロジック層（最重要領域）
├── packages/
│   ├── protocol/                ← Zod イベントスキーマ（OfficeEvent / OfficeLayout / Character）
│   ├── relay/                   ← ローカル常駐 CLI（hooks 受信・正規化・転送）
│   └── cc-sier-adapter/         ← CC-SIer masters/task-log → 正規化 JSON への変換
├── docs/
│   └── design/                  ← 設計成果物（cc-sier からのコピー + origin.md）
├── .claude/
│   ├── agents/                  ← maker 4 種 + checker（office-qa）
│   ├── rules/                   ← 拡張子・パス別の開発ルール（自動ロード）
│   ├── hooks/verify/            ← 検証 hooks（B 系統。違反時 exit 2 でブロック）
│   └── skills/                  ← office-verify / office-develop
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── CLAUDE.md（本ファイル）
```

## 開発規約

**拡張子・パス別の詳細規約は `.claude/rules/` を正とする**（該当ファイルの Read/Edit 時に自動ロードされる。typescript / game-layer / tests / shell / markdown / config の 6 本）。以下は全体像の要約:

1. **`apps/web/game/` は React に依存しない**ことを維持する。React API（`useState`/`useEffect`等）の import を持ち込まない。ゲーム状態は `OfficeState` クラス（`requestAnimationFrame` ループ）で管理し、React 側は参照渡し・イベント購読のみで連携する
2. **`packages/protocol` が唯一のスキーマ正本**。`OfficeEvent` / `OfficeLayout` / `Character` の型変更時は必ず `packages/relay` と `apps/web` 両方の関連テストを実行してから完了とすること
3. **hooks 側コマンドは `--max-time 2 || true` を必須**とし、exit code 2（ツール実行ブロック）を絶対に返さない。Relay 未起動時でも Claude Code の動作を一切妨げないこと
4. **機微情報（プロンプト本文・ファイル内容・URL クエリ）は Relay の正規化段階で破棄**し、クラウド（将来の Vercel 転送先含む）へ送らない。保存するのは `tool_name` / `file_path`（ベース名まで）/ `subagent_type` 程度に限定する
5. **ピクセル素材は CC0 / CC-BY 系のみ使用**し、出典を `README.md` および画面フッターの両方に表記する
6. **コミットは Conventional Commits**（`feat:` / `fix:` / `docs:` / `refactor:` / `chore:` 等）に従う

## 関連 Subagent

- `game-engine-dev` — Canvas/状態機械/経路探索（`apps/web/game/` 専任）
- `pipeline-dev` — Relay/protocol/ingest（イベントパイプライン）
- `ui-dev` — Next.js/React シェル・画面
- `org-adapter-dev` — cc-sier-adapter（組織インポート・リプレイ変換）
