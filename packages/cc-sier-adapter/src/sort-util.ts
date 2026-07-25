// 決定論的な文字列比較（Phase 3 レビュー指摘 2 の修正）。
//
// String.prototype.localeCompare は実行環境のロケール設定に依存し、大文字・
// アンダースコア等を含む org id で順序が変わりうる（例: ["a_z","a-z","B-y"] は
// en ロケールの localeCompare だと入力順のまま、既定の Array.prototype.sort()
// （codepoint/UTF-16 コード単位比較）だと ["B-y","a-z","a_z"] になる）。
// cli.ts の discoverOrgs や attribution-index.ts の branchOrgs は元々
// 既定 Array.prototype.sort() を使っており codepoint 順になっていたため、
// localeCompare を使っていた箇所（import-org.ts の importOrganizations、
// attribution-index.ts の sortedOrgs）だけ順序が食い違い、決定論性
// （AC-3 のバイト同一性）の前提が崩れていた。オブジェクト配列をキー文字列で
// ソートする箇所は必ずこの関数を使い、既定 Array.prototype.sort() と同じ
// 比較規則に統一する。
export function compareCodePoint(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
