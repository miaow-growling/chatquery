// Wire types matching the Rust `commands.rs` DTOs.

export interface ConnSummary {
  id: string;
  name: string;
  db_type: "mysql" | "redis";
  host: string;
  port: number;
  user: string;
  database: string;
  /// First-class group id this connection belongs to (ADR-016). null = ungrouped.
  group_id: string | null;
}

export interface ConnInput {
  id: string;
  name: string;
  db_type: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  group_id: string | null;
  // --- SSL / TLS (#4) ---
  ssl_mode: string;
  ssl_ca: string;
  client_cert: string;
  client_key: string;
  // --- SSH tunnel / bastion (#5) ---
  ssh_host: string;
  ssh_port: number;
  ssh_user: string;
  ssh_auth_kind: string;
  ssh_password: string;
  ssh_private_key: string;
}

/// Left-tree model (ADR-016): environments → groups → connections. Empty
/// containers appear naturally with empty `connections` arrays.
export interface TreeModel {
  environments: EnvNode[];
}

export interface EnvNode {
  id: string;
  name: string;
  order: number;
  /// Database type this environment is bound to (ADR-022). Missing on legacy
  /// data ⇒ treat as "mysql".
  db_type?: "mysql" | "redis";
  groups: GroupNode[];
}

export interface GroupNode {
  id: string;
  name: string;
  order: number;
  connections: ConnSummary[];
}

export type QueryOutput =
    | {
      kind: "table";
      columns: string[];
      rows: string[][];
      truncated: boolean;
      total?: number;
      page?: number;
      pageSize?: number;
      /// Primary-key column names (browse path only). Empty => no stable row
      /// identity, so the UI must not allow edits.
      primaryKeys?: string[];
    }
  | {
      kind: "redis";
      command: string;
      lines: string[];
      note: string;
      truncated: boolean;
    };

export interface ColumnInfo {
  name: string;
  data_type: string;
  key: string;
  nullable: string;
  default: string | null;
}

export interface TableMeta {
  name: string;
  is_view: boolean;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
}

export interface Schema {
  tables: TableInfo[];
}

export interface StatusInfo {
  llm_enabled: boolean;
  mask_enabled: boolean;
}

/// Current LLM config shown in the settings UI. `api_key` is intentionally
/// omitted — the form shows a blank field and only sends a new key.
export interface LlmConfigDto {
  vendor: string;
  base_url: string;
  model: string;
  provider: string;
  enabled: boolean;
}

/// A selectable vendor preset for the settings dropdown.
export interface VendorPreset {
  id: string;
  label: string;
  provider: string;
  base_url: string;
  model: string;
}

/// Settings form payload sent to `save_llm_config`. `api_key` empty = keep
/// the stored key.
export interface LlmConfigInput {
  vendor: string;
  base_url: string;
  model: string;
  api_key: string;
}

/// A logged or saved query from the `queries` table. `name` is null for
/// auto-logged history entries and set for user-named snippets.
export interface QueryItem {
  id: string;
  name: string | null;
  sql: string;
  conn_id: string | null;
  db: string | null;
  /// Unix seconds.
  created: number;
}

export interface ChatMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
}

/// A chat-log entry. Superset of `ChatMessage`: the log can also hold a `plan`
/// card, which is UI-only and must be stripped before the history is sent back
/// to the model (the Rust `ChatRole` has no such variant).
export type ChatItem =
  | ChatMessage
  | { role: "plan"; content: string; steps: string[] };

/// A write statement the AI guardrail paused, awaiting the user's verdict
/// (ADR-AI-1 / ADR-AI-4). Answer via `resolveConfirm(turn_id, id, approved)`.
export interface ConfirmRequest {
  id: string;
  turn_id: string;
  connection: string;
  sql: string;
  reason: string;
}

/// Payload for the `apply_edit` command (ADR-018): write back one row's edited
/// cells. `pk` locates the row by its ORIGINAL primary-key values; `set` carries
/// the new column values.
export interface EditPayload {
  connId: string;
  database: string;
  table: string;
  pk: Array<{ col: string; val: string }>;
  set: Array<{ col: string; val: string }>;
}

/// A column's full structure detail (ADR-020). Richer than `ColumnInfo`:
/// `column_type` is the full type string (`varchar(255)`, `int unsigned`),
/// and `extra` captures `auto_increment` etc.
export interface ColumnDetail {
  name: string;
  column_type: string;
  nullable: boolean;
  key: string;
  default: string | null;
  extra: string;
}

/// One (index, column) pair. Multi-column indexes produce multiple entries
/// with increasing `seq`. Group by `name` on the frontend.
export interface IndexInfo {
  name: string;
  column: string;
  unique: boolean;
  seq: number;
}

/// Full table structure: columns, indexes, and the CREATE TABLE DDL.
export interface TableStructure {
  columns: ColumnDetail[];
  indexes: IndexInfo[];
  create_sql: string;
}

/// A foreign-key relationship (ADR-021). Each entry is one column referencing
/// another table's column; a composite FK produces multiple entries sharing
/// the same `constraint_name`.
export interface ForeignKeyInfo {
  constraint_name: string;
  table_name: string;
  column_name: string;
  referenced_table: string;
  referenced_column: string;
}

/// Non-secret view of the configurable connection key K (#0).
export interface KeyStatus {
  /// true = the user has configured a custom key (otherwise K degenerates to
  /// the built-in KEK and behaves exactly like a pre-#0 install).
  configured: boolean;
}

/// Outcome of an import, surfaced to the UI for a summary toast (#1, #2).
export interface ImportResult {
  /// Connections successfully added (ids regenerated, passwords re-encrypted).
  connections_added: number;
  /// Environments + groups created to host the imported connections.
  containers_added: number;
  /// Names of connections whose (decrypted) password is empty — the user must
  /// fill these in before they can connect.
  passwords_needed: string[];
  /// Names skipped because a required field (name/host/user) was empty.
  skipped: string[];
  /// Non-fatal notices (e.g. a placeholder value was detected).
  warnings: string[];
}

/// One node of the EXPLAIN execution-plan tree (#6).
export interface ExplainNode {
  /// Table name; subquery nodes are "SUBQUERY" / "DERIVED" etc.
  name: string;
  /// Access type: ALL / index / range / ref / eq_ref / const / system.
  access_type: string;
  /// Estimated rows scanned.
  rows: number;
  /// Node cost (cost_info.query_cost).
  cost: number;
  /// Index actually used (key).
  key: string;
  /// Candidate indexes (possible_keys).
  possible_keys: string[];
  /// Extra info (attached_condition etc.).
  extra: string;
  /// Nested accesses (JOIN / subquery).
  children: ExplainNode[];
}

/// EXPLAIN visualisation result (#6). `format` = "json" (parsed tree) or
/// "legacy" (text plan, when JSON parsing failed / unsupported version).
export interface ExplainVisual {
  format: string;
  nodes: ExplainNode[];
  raw: string | null;
}

/// Knowledge-base document (ADR-AI-6). Plain-text / Markdown content that the
/// AI agent can read when answering queries for bound connections / databases.
export interface KbBindingDto {
  /// Connection id this document is bound to.
  conn_id: string;
  /// null = bound to the whole connection; a name = bound to that database only.
  database: string | null;
}
export interface KbDocDto {
  id: string;
  name: string;
  content: string;
  created: string;
  updated: string;
  bindings: KbBindingDto[];
}
/// Input row for `set_kb_bindings`.
export interface KbBindingInput {
  conn_id: string;
  database: string | null;
}
