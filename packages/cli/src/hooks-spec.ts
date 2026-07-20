/**
 * ai-office setup が投入する観測 hooks（A系統）の唯一の正本。
 * 要件 §5.2 の 8 イベント。アーキ設計 §6.1 のコマンド形状に一致させる。
 *
 * CLI が生成する hook はこのマーカーで識別する。本リポジトリ自身の
 * `.claude/settings.json` は手書きで `#ai-office`（このマーカーの接頭辞のみ）
 * を使っており、意図的に区別している（teardown が手書き配線を消さないため）。
 */
export const MARKER = "#ai-office:cli";

export interface HookSpecEntry {
  /** Claude Code hooks のイベント名（例: "PreToolUse"）。 */
  readonly event: string;
  /** Relay の `/hooks/:event` ルーティング識別子（`packages/relay` の HOOK_EVENT_SLUGS と一致させる）。 */
  readonly slug: string;
  /** PreToolUse/PostToolUse のみ "*"。他 6 件は matcher キー自体を持たない。 */
  readonly matcher?: string;
}

export const HOOKS_SPEC: readonly HookSpecEntry[] = [
  { event: "SessionStart", slug: "session-start" },
  { event: "UserPromptSubmit", slug: "user-prompt" },
  { event: "PreToolUse", slug: "pre-tool", matcher: "*" },
  { event: "PostToolUse", slug: "post-tool", matcher: "*" },
  { event: "Notification", slug: "notification" },
  { event: "Stop", slug: "stop" },
  { event: "SubagentStop", slug: "subagent-stop" },
  { event: "SessionEnd", slug: "session-end" },
];

/** Relay が受理する URL（`/hooks/:event` のパスパラメータは slug）。 */
export function buildTargetUrl(slug: string, port: number): string {
  return `http://localhost:${port}/hooks/${slug}`;
}

/**
 * hooks コマンド本体を生成する。NFR-2（hooks は Claude Code をブロックしない）
 * のため `--max-time 2` と `|| true` を必ず含む。末尾のマーカーは teardown が
 * 自分の追加分だけを識別するために使う。
 */
export function buildCommand(slug: string, port: number): string {
  return `curl -s -X POST ${buildTargetUrl(slug, port)} -H 'Content-Type: application/json' -d @- --max-time 2 || true ${MARKER}`;
}
