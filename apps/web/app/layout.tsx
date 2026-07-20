import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "AI Virtual Office",
};

// デザイントークン（docs/design/ui/README.md 抽出仕様1）を body に inline style で最小適用する。
// CSS ファイルは作らず、M0 はここでの直書きに留める。
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          backgroundColor: "#141017",
          color: "#efe6d6",
          fontFamily: "'DotGothic16', monospace",
        }}
      >
        {children}
      </body>
    </html>
  );
}
