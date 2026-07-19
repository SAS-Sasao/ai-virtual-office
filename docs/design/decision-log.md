# 設計決定ログ（Decision Log）

| 項目 | 内容 |
|------|------|
| ドキュメント種別 | アーキテクチャ決定記録（ADR）の蓄積ログ |
| 運用 | 1 決定 = 1 エントリで追記する。過去エントリは書き換えず、覆す場合は新エントリで supersede する |
| 上位ドキュメント | [要件定義](./requirements.md) / [アーキテクチャ設計](./architecture-design.md) |

---

## ADR-001: コアアプリを Docker 管理しない

| 項目 | 内容 |
|---|---|
| 日付 | 2026-07-20 |
| ステータス | 採用（Accepted） |
| 決定 | **アプリ本体（Relay / Next.js / adapter）の開発・実行・配布に Docker を使わない。** ただし後述の 2 用途に限り、該当マイルストーンで限定的にコンテナを使う |

### 背景

M0 着手前の環境整備の過程で「このアプリケーションは Docker 管理したほうがよいのでは」という論点が挙がった（2026-07-20 相談）。

### 不採用の理由

1. **本アプリは「ホスト環境の観測者」であり、Docker は観測対象との間に隔離壁を作る。** 入力はすべてホスト側にある — Claude Code hooks は開発者マシンの `localhost:4100` へ curl し（要件 §5.2）、保険系はホストの `~/.claude/projects/**/*.jsonl` を読み、adapter は組織リポジトリ（`~/cc-sier-organization` 等）の masters / task-log を読む。コンテナ化するとこれら全てのボリュームマウントが必要になる上、FR-4 の帰属推定は hooks イベントの `cwd`（ホスト絶対パス）と登録リポジトリパスの照合で動くため、**コンテナ内外のパス差異が帰属ロジックを壊す**
2. **配布モデルが npx 前提（NFR-5）と衝突する。** 「`pnpm dev` + `npx ai-office-relay` の 2 プロセスで完結」が可搬性要件であり、想定ユーザー（Claude Code 利用者）は Node を必ず持つ。Docker Desktop の前提追加は導入障壁の純増で、`npx ai-office setup` の導入・撤去体験（要件 §5.1）と噛み合わない
3. **Docker の主メリット（環境固定）は既に別手段で担保済み。** corepack + `packageManager: pnpm@9.0.0` 固定 + lockfile + [dev-environment.md](../dev-environment.md)（AI 指示書による検証・構築の自動化）で解決している。また WSL2 + Docker はポートフォワーディングの層を増やし、NFR-2（hooks が Claude Code を一切ブロックしない）に対する障害点を追加する方向に働く
4. **本番デプロイ経路にもコンテナが登場しない。** M3 は Vercel（serverless）+ マネージド Postgres / Realtime（AR-3、アーキ設計 §3.3）であり、コンテナホスティングは使わない

### 限定的に採用する 2 用途（アプリ本体は含めない）

| 時期 | 用途 | 理由 |
|---|---|---|
| M2 | CI の視覚回帰テスト（`toHaveScreenshot`）を Playwright 公式 Docker イメージ内で実行 | フォント・レンダリング環境差によるフレークの根絶（設計書 §5.4 のフレーク対策と整合）。第 2 層（視覚回帰）に限定し、第 1 層（Debug State API の状態 assert）はコンテナ不要 |
| M3 | SQLite → Postgres 移行検証用の使い捨て Postgres を docker-compose で 1 サービスのみ起動 | Drizzle スキーマの互換検証用。アプリ本体はコンテナに入れない |

### 再検討の条件（このいずれかが起きたら本 ADR を見直す）

- 配布対象が「Node を持たないユーザー」へ拡大したとき
- デプロイ先が Vercel からコンテナホスティング（ECS / Cloud Run 等）へ変わったとき
- 観測方式が hooks / ローカルファイル読み取り以外（ネットワーク API 経由等）へ変わり、ホスト密着の必然性が消えたとき
