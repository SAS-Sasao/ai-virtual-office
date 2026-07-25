"use client";

import { ACCENT_PRIMARY, BORDER_COLOR, PAGE_BG, PANEL_BG, TEXT_PRIMARY } from "./tokens";

export interface FloorTabItem {
  org: string;
  label: string;
}

export interface FloorTabsProps {
  floors: readonly FloorTabItem[];
  selectedOrg: string | undefined;
  onSelect: (org: string) => void;
}

/**
 * フロア切替タブ（layout.floors から生成）。クリックで `scene.setFloor` /
 * `renderer.setFloor` を呼ぶのは呼び出し側（page.tsx）の責務で、本コンポーネントは
 * `onSelect(org)` を呼ぶだけ（ナビゲーション操作であり AC-7 のエージェント操作系
 * 制限の対象外 = フロア表示の切替に過ぎない）。
 */
export function FloorTabs({ floors, selectedOrg, onSelect }: FloorTabsProps) {
  if (floors.length === 0) return null;

  return (
    <div style={{ display: "flex", gap: 4 }} role="tablist" aria-label="フロア切替">
      {floors.map((floor) => {
        const active = floor.org === selectedOrg;
        return (
          <button
            key={floor.org}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(floor.org)}
            style={{
              fontFamily: "inherit",
              fontSize: 12,
              padding: "6px 12px",
              cursor: "pointer",
              border: `2px solid ${BORDER_COLOR}`,
              backgroundColor: active ? ACCENT_PRIMARY : PAGE_BG,
              color: active ? PANEL_BG : TEXT_PRIMARY,
              fontWeight: active ? "bold" : "normal",
            }}
          >
            {floor.label}
          </button>
        );
      })}
    </div>
  );
}
