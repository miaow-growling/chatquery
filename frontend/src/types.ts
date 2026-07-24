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
