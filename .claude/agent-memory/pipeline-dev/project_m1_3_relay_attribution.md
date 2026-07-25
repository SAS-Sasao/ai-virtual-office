---
name: m1-3-relay-attribution
description: M1-3 で relay 側に帰属推定（FR-4）を結線した際の設計判断・並行作業待ちの実務・attribute.ts のロジック
metadata:
  type: project
---

M1-3（`feat/2026-07-25-m1-3-adapter` ブランチ）で `packages/protocol/src/events.ts` に org/dept/role を追加し、`packages/relay/src/attribute.ts`（新規）で汎用 lookup を実装し、`server.ts`/`cli.ts` に結線し、`apps/web/game/office-state.ts` にパススルーした際のログ。担当分担は org-adapter-dev が `packages/protocol/src/layout.ts` / `attribution.ts` / `index.ts` と `packages/cc-sier-adapter/` を並行して触っていた。

**並行作業での依存待ちは「ポーリング」で十分機能した**: `AttributionIndexSchema` は org-adapter-dev が `packages/protocol/src/attribution.ts` に定義する契約で、自分は「自前でスキーマを再定義しない」制約があったため、`for i in ...; do [ -f ... ] && exit; sleep 5; done` 形式の bash ループ（`timeout` 付き、または `run_in_background` + 通知）で存在確認しながら他の準備作業（既存コードリーディング、テスト方針の設計）を進めた。実際に src/attribution.ts → src/index.ts への export 追加 → dist ビルドの3段階で合計数分のタイムラグがあり、各段階を個別にポーリングする必要があった（1回のポーリングで「ファイルはあるが index.ts が export していない」「index.ts は export したが dist が古い」を見逃さないこと）。**dist が古いまま consumer 側の型を import しようとすると原因不明の型エラーになるので、`node -e "import('@pkg').then(m=>console.log(Object.keys(m)))"` で実際に解決される exports を都度確認すると確実**。

**FR-4 規則の優先順位実装（[[m1-1-protocol-extraction]] の delta）**: 規則3（subagent_type一致）は「dept/role が規則1/2より詳細」なだけでなく、**org も含めて丸ごと上書きする**（規則1/2は org のみしか算出できないため）。実装は「規則3を先にチェックしてマッチしたら即 return」→「マッチしなければ規則1→規則2」の順にし、規則1/2は org 単独の `{ org }` のみを返す設計にした。設計メモの文言（「規則1/2より優先」）だけでは規則3が org も上書きするのか曖昧だったため、「cwd 由来の org と subagent_type 由来の org が矛盾するケース」を明示的にテストして仕様を固定した。

**`.git/HEAD` の異常系はすべて「例外を握り潰す」の一本槍で正しく落ちる**: detached HEAD（内容が生 SHA）は正規表現 `^ref:\s+refs\/heads\/(.+)$` が単純にマッチしないので undefined、`.git` がファイル（worktree/submodule）は `readFileSync(join(cwd,".git","HEAD"))` が ENOTDIR で例外、`.git` 不在は ENOENT で例外。特別分岐は一切不要で、`try { ... } catch { branch = undefined; }` だけで全ケースを満たせた（[[normalize-whitelist-pattern]] と同じ「握り潰し一本化」の哲学）。cwd 前方一致（規則1）は文字列境界に注意: `cwd === prefix || cwd.startsWith(prefix + "/")` を必ず両方チェックしないと `"/repo"` が `"/repo-other"` に誤マッチする（単純な `startsWith(prefix)` だけは NG）。

**キャッシュ TTL のテストは `now` 注入 + ファイル書き換えの組み合わせで sleep 無し実現**: 既定 readBranch は cwd 単位で TTL 60秒キャッシュを持つ。テストは (1) HEAD ファイルを書く (2) `now()` を固定値で呼ぶ (3) ファイル内容を書き換える (4) TTL 内の `now` で呼んで「古い値のまま」を検証 (5) TTL 超過の `now` で呼んで「新しい値に切り替わる」を検証、という手順で決定論的に検証できた。sleep は一切不要。

**server.ts への結線は EventSink と同じ「DI + 既定 no-op」パターン**: `attribute?: Attributor`（既定 `() => ({})`）を `CreateServerOptions` に追加し、normalize 成功後・seq採番前に `{ ...normalized, ...attribution, seq: nextSeq() }` の順でマージした。`attribute(raw)` 呼び出しは NFR-2 の「forward が throw しても 200」と同じ二重防御パターンで try/catch し、失敗時は `{}` 扱い（org/dept/role 無しで forward。200 は維持）。**attribute には正規化前の raw を渡す**（normalize 後は cwd が消えているため）。

**cli.ts の `--attribution` 実装は `resolveSeqPath`/`createPersistentSeqCounter` と全く同じ二層構造**: `resolveAttributionPath(env)`（`AI_OFFICE_ATTRIBUTION_PATH` > `~/.ai-office/layouts/attribution.json`、DI可能で unit test 対象）+ `loadAttributor({ path, readFileSync?, log? })`（ファイル無し/JSON不正/スキーマ検証失敗の3経路をすべて「no-op Attributor を返すだけで例外を投げない」に統一し、診断ログは `log()` DI 経由で1行だけ・**パスのみ含めて内容は含めない**ことをテストで担保）。cli.ts 本体の実配線（`loadAttributor({ path: args.attribution ?? resolveAttributionPath() })` を `createServer` に渡す部分）は `cli.test.ts` が存在しない既存方針（seq のときと同じ）に倣い、テストは resolveAttributionPath / loadAttributor 側の unit test で担保するに留めた。

**office-state.ts のパススルーは「キーごと省略」でしか安全に実現できない**: `SessionCharacter` に `org?/dept?/role?` を足し、「後着イベントに帰属が無ければ既存を保持」を実現するには、`upsert` の patch オブジェクトに `org: undefined` を**明示的に含めてはいけない**（スプレッドで既存値を上書きしてしまう）。`attributionPatch(ev)` ヘルパーで `ev.org !== undefined` のときだけキー自体を patch に含める設計にした（`toolName` の既存パススルーと同じ「デフォルト値を先に置き、`...patch` を後に spread、ただし patch には値がある時だけキーを含める」パターン）。

**ambient な実行環境に注意**: この作業中、`ps aux` で `pnpm --filter web dev`（別プロセス、port 3001）が既に稼働しており、`~/.ai-office/events.db` / `relay-seq.json` が自分のコマンドと無関係に更新され続けていた（実際の hooks トラフィックを受けている可能性が高い）。**自分のテスト/build/typecheck コマンドが実 home を汚していないかを確認する際は、`stat` の mtime と自分のコマンド実行時刻を突き合わせるだけでなく `ps aux` で ambient なプロセスの存在を先に確認すること**（誤って自分の作業のせいだと早合点しない）。web のテストは `apps/web/vitest.config.ts` の `env: { AI_OFFICE_DB_PATH: ":memory:" }` でプロセス全体が in-memory 固定されているため、テスト経由で実 DB が汚れることは無い。

関連: [[m1-1-protocol-extraction]] [[m1-1-relay-creation]] [[m1-2a-relay-persistence]] [[m1-2b-relay-health-stats]] [[normalize-whitelist-pattern]]
