// CC-SIer masters/*.md（organization.md / departments.md / roles.md）の純関数パーサ。
// fs には一切触れない（テストは fixture 文字列のみで完結する）。
//
// 実マスタのゆらぎへの耐性:
// - `## <id>` 見出しの無い文書（organization.md）は単一セクション（id: ""）として扱う
// - roles.md はキー名が組織間で揺れる（部署 vs 所属部署、モデル vs model）。ここでは
//   総称的な key/value 抽出のみ行い、キー名のゆらぎ吸収は parseRoles 側の候補キー
//   リストで行う
// - テイメイト指示テンプレートのようなコードフェンス（```）内の行はキー/値として拾わない
// - 未知キーは無視する（既知キーだけを見るドメインパーサ側で自然に無害化される）
// - 必須キー欠落は「そのセクションだけスキップ」して継続する。1 セクションの破損で
//   ドキュメント全体のパースを失敗させない（呼び出し側 = import-org.ts が
//   「0 件になったら失敗」の最終判断を行う）

export type MasterFieldValue = string | string[];
export type MasterFields = Record<string, MasterFieldValue>;

export interface MasterSection {
  /** `## <id>` 見出しのテキスト。見出しの無い文書では空文字列。 */
  id: string;
  fields: MasterFields;
}

const HEADING_RE = /^##\s+(.+?)\s*$/;
const BULLET_RE = /^-\s+\*\*(.+?)\*\*:\s*(.*)$/;
const FENCE_RE = /^```/;
const ARRAY_RE = /^\[(.*)\]$/;

function parseFieldValue(raw: string): MasterFieldValue {
  const trimmed = raw.trim();
  const arrayMatch = ARRAY_RE.exec(trimmed);
  if (arrayMatch) {
    const inner = arrayMatch[1].trim();
    if (inner.length === 0) return [];
    return inner
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return trimmed;
}

function parseFieldsFromLines(lines: string[]): MasterFields {
  const fields: MasterFields = {};
  let inFence = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = BULLET_RE.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    fields[key] = parseFieldValue(value);
  }
  return fields;
}

/**
 * `## <id>` 見出しでセクション分割し、各セクション本文の `- **キー**: 値` 箇条書きを
 * 抽出する。見出しが 1 つも無い場合はドキュメント全体を単一セクション（id: ""）として
 * 扱う（organization.md 用）。CRLF/LF どちらの改行にも対応する。
 */
export function parseMasterSections(markdown: string): MasterSection[] {
  const lines = markdown.split(/\r\n|\r|\n/);
  const headingIdx: number[] = [];
  lines.forEach((line, i) => {
    if (HEADING_RE.test(line)) headingIdx.push(i);
  });

  if (headingIdx.length === 0) {
    return [{ id: "", fields: parseFieldsFromLines(lines) }];
  }

  const sections: MasterSection[] = [];
  for (let s = 0; s < headingIdx.length; s += 1) {
    const start = headingIdx[s];
    const end = s + 1 < headingIdx.length ? headingIdx[s + 1] : lines.length;
    const headingMatch = HEADING_RE.exec(lines[start]);
    const id = headingMatch ? headingMatch[1].trim() : "";
    const body = lines.slice(start + 1, end);
    sections.push({ id, fields: parseFieldsFromLines(body) });
  }
  return sections;
}

function firstString(fields: MasterFields, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = fields[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function firstArray(fields: MasterFields, keys: string[]): string[] | undefined {
  for (const key of keys) {
    const value = fields[key];
    if (Array.isArray(value)) return value;
  }
  return undefined;
}

export interface DepartmentRecord {
  id: string;
  name: string;
  status: "active" | "standby";
  triggers: string[];
  subagents: string[];
}

export interface ParseDepartmentsResult {
  departments: DepartmentRecord[];
  /** スキップされたセクションの理由（部分継続のログ。呼び出し側が stderr へ出す）。 */
  errors: string[];
}

const NAME_KEYS = ["名称"];
const STATUS_KEYS = ["ステータス"];
const TRIGGER_KEYS = ["トリガーワード"];
const SUBAGENT_KEYS = ["対応Subagent"];

/**
 * departments.md を解析する。`名称` / `ステータス`（active|standby のいずれか）を必須とし、
 * 欠落・不正値のセクションはエラーに記録して読み飛ばす（1 部署の破損で全体を失敗させない。
 * ただし parseMasterSections が見出し無しと判定した文書は 0 件を返す＝呼び出し側の
 * 「0 件になったら失敗」判定に委ねる）。
 */
export function parseDepartments(markdown: string): ParseDepartmentsResult {
  const sections = parseMasterSections(markdown);
  const departments: DepartmentRecord[] = [];
  const errors: string[] = [];

  for (const section of sections) {
    if (section.id.length === 0) continue; // 見出し無し（プロローグ相当）は department として扱わない

    const name = firstString(section.fields, NAME_KEYS);
    const statusRaw = firstString(section.fields, STATUS_KEYS);
    const missing: string[] = [];
    if (!name) missing.push("名称");
    if (!statusRaw) missing.push("ステータス");
    if (missing.length > 0) {
      errors.push(`department "${section.id}": missing required field(s): ${missing.join(", ")}`);
      continue;
    }
    if (statusRaw !== "active" && statusRaw !== "standby") {
      errors.push(`department "${section.id}": unrecognized ステータス value "${statusRaw}" (expected active|standby)`);
      continue;
    }

    departments.push({
      id: section.id,
      name: name as string,
      status: statusRaw,
      triggers: firstArray(section.fields, TRIGGER_KEYS) ?? [],
      subagents: firstArray(section.fields, SUBAGENT_KEYS) ?? [],
    });
  }

  return { departments, errors };
}

export interface RoleRecord {
  id: string;
  name: string;
  dept: string;
  model?: string;
  description?: string;
}

export interface ParseRolesResult {
  roles: RoleRecord[];
  errors: string[];
}

// roles.md はマスタごとにキー名が揺れる（実測: domain-tech-collection は「部署」/
// 「モデル」、jutaku-dev-team・standardization-initiative は「所属部署」/「model」）。
// 両方を候補キーとして受け付ける。
const ROLE_NAME_KEYS = ["名称"];
const ROLE_DEPT_KEYS = ["部署", "所属部署"];
const ROLE_MODEL_KEYS = ["モデル", "model"];
const ROLE_DESCRIPTION_KEYS = ["説明"];

/**
 * roles.md を解析する。所属部署（部署/所属部署のいずれか）を必須とし、欠落したロールは
 * エラーに記録して読み飛ばす。名称キーが無い組織（jutaku-dev-team 等）では表示名を
 * ロール ID にフォールバックする。
 */
export function parseRoles(markdown: string): ParseRolesResult {
  const sections = parseMasterSections(markdown);
  const roles: RoleRecord[] = [];
  const errors: string[] = [];

  for (const section of sections) {
    if (section.id.length === 0) continue;

    const dept = firstString(section.fields, ROLE_DEPT_KEYS);
    if (!dept) {
      errors.push(`role "${section.id}": missing required field: 部署/所属部署`);
      continue;
    }

    const name = firstString(section.fields, ROLE_NAME_KEYS) ?? section.id;
    const model = firstString(section.fields, ROLE_MODEL_KEYS);
    const description = firstString(section.fields, ROLE_DESCRIPTION_KEYS);

    roles.push({
      id: section.id,
      name,
      dept,
      ...(model !== undefined ? { model } : {}),
      ...(description !== undefined ? { description } : {}),
    });
  }

  return { roles, errors };
}

export interface OrganizationRecord {
  /** 組織名（フロアの label に使う表示名）。欠落時は呼び出し側がディレクトリ id にフォールバックする。 */
  name?: string;
  /** 組織ID（参考情報。ディレクトリ名と一致する想定だが、突合には使わない）。 */
  orgId?: string;
}

export interface ParseOrganizationResult {
  organization: OrganizationRecord;
  errors: string[];
}

const ORG_NAME_KEYS = ["組織名"];
const ORG_ID_KEYS = ["組織ID"];

/**
 * organization.md を解析する。`## <id>` 見出しを持たない単一ブロックの文書のため、
 * 先頭セクション（id: ""）の fields のみを見る。組織名の欠落はエラーにしない
 * （フロアはディレクトリ名で機能するため、組織全体を失敗させる理由にならない）。
 */
export function parseOrganization(markdown: string): ParseOrganizationResult {
  const sections = parseMasterSections(markdown);
  const fields = sections[0]?.fields ?? {};
  return {
    organization: {
      name: firstString(fields, ORG_NAME_KEYS),
      orgId: firstString(fields, ORG_ID_KEYS),
    },
    errors: [],
  };
}
