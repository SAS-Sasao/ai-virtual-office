#!/usr/bin/env node
// perf-scene.mjs — NFR-1（60fps / キャラ 30 体）の参考計測ランナー【非ブロッキング・office-verify 対象外】
//
// 方針（M1-4a 設計メモ AC-8 / Phase 1 finding F4）:
//   決定論テストスイートに wall-clock 計測を混ぜない。実時間の計測はこのスクリプトに分離し、
//   CI ゲートにしない（参考値のみ）。
//
// 現状の実装状態:
//   - ユニットテスト側で「静的レイヤー（z0〜z2）がフロアあたり 1 回しか描画されない」ことを
//     描画呼び出し記録スタブで機械検証している（apps/web/game/renderer.test.ts）。
//     毎フレームのコストは「1 drawImage + キャラ/オーバーレイ」に設計上抑えられている。
//   - ブラウザ実測（フレームレート・30 体負荷）は M2 の視覚回帰導入時に Playwright の
//     トレース（trace.zip の frame timing）で行う。TS モジュール（apps/web/game/*.ts）を
//     Node から直接 import する経路は Node バージョン依存（型ストリップ）があるため、
//     ここでは行わない（M1-1 の教訓: 開発機で動く ≠ 要件の Node で動く）。
//
// 使い方（手動の粗い確認）:
//   pnpm dev で起動し、ブラウザ DevTools の Performance タブで
//   http://localhost:3001/?e2e=0 を記録 → Frames が 60fps 近傍であることを目視確認する。
console.log("perf-scene: 実時間計測は M2（Playwright トレース）で導入予定です。");
console.log("現時点の NFR-1 担保: renderer.test.ts の静的レイヤー 1 回描画 assert（機械検証）");
console.log("+ 手動確認手順（このファイルのコメント参照）。");
