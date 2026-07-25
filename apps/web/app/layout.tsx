import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "AI Virtual Office",
};

// デザイントークン（docs/design/ui/README.md 抽出仕様1: v3 ダークネイビー）を
// body に inline style で最小適用する。CSS ファイルは作らず、直書きに留める
// （M1-4b: v2 のウッド調 #141017/#efe6d6 は不採用となったため v3 へ移行）。
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          backgroundColor: "#0b0d18",
          color: "#e8eaf6",
          fontFamily: "'DotGothic16', monospace",
        }}
      >
        {children}
      </body>
    </html>
  );
}
