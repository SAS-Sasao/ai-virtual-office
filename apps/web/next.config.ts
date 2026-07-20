import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 検証ビルド（office-verify）と dogfooding の `next dev` が同じ .next を共有すると、
  // webpack chunk の食い違いで dev サーバが 500 に落ちる（実測済み）。
  // NEXT_DIST_DIR を分けることでビルド成果物の衝突を根治する。
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
