---
paths:
  - "apps/web/game/**"
---

# game 層ルール（apps/web/game/ 配下）

**このディレクトリは React 非依存を絶対に維持する（NFR-7。guard-game-react hook が exit 2 でブロックする）。**

1. `react` / `react-dom` / `next` の import を書かない。`useState` / `useEffect` 等の React API を持ち込まない
2. ゲーム状態は `OfficeState` クラス（`requestAnimationFrame` ループの命令的更新）で管理する。React の再レンダリングに乗せない
3. React 側との連携は「`OfficeState` インスタンスの参照渡し」または「イベントリスナー登録」のみ。React 連携コードが必要になったら `apps/web/app/` 側のアダプタ層に置く
4. この層は単体テスト可能・移植可能に保つ（Node 環境でロジックがテストできる構造。Canvas 依存は renderer に隔離）
5. 見た目の仕様（状態別の色・スプライト・モーション値）は `docs/design/ui/` の抽出仕様を正として Canvas で再現する
6. 性能要件: キャラ 30 体・イベント 10 件/秒で 60fps（NFR-1）。フレーム内でのアロケーション・レイアウト計算を避ける
