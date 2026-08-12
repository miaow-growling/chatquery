import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AuditRow,
  ChatMessage,
  ColumnInfo,
  ConfirmRequest,
  ConnInput,
  ConversationDetail,
  ConversationRef,
  ConversationSummary,
  EditPayload,
  ExplainVisual,
  ForeignKeyInfo,
  ImportResult,
  KeyMeta,
  KeyStatus,
  KbBindingInput,
  KbDocDto,
  LlmConfigDto,
  LlmConfigInput,
  NewChatMessage,
  QueryItem,
  QueryOutput,
  Schema,
  SqlReference,
  StatusInfo,
  TableMeta,
  TableStructure,
  TokenUsage,
  TreeModel,
  VendorPreset,
  WriteRisk,
} from "./types";

const PAGE_SIZE = 200;

export const api = {
  /// Full tree model (environments → groups → connections), supersedes
  /// `list_connections`.
  listTree: () => invoke<TreeModel>("list_tree"),
  addConnection: (cfg: ConnInput) => invoke("add_connection", { cfg }),
  updateConnection: (cfg: ConnInput) => invoke("update_connection", { cfg }),
  deleteConnection: (id: string) => invoke("delete_connection", { id }),
  testConnection: (cfg: ConnInput) => invoke<boolean>("test_connection", { cfg }),
  executeQuery: (
    connId: string,
    query: string,
    db?: string | null,
    page?: number,
    pageSize?: number,
    allowRisky?: boolean
  ) =>
    invoke<QueryOutput>("execute_query", {
      connId,
      query,
      db: db ?? "",
      page: page ?? 0,
      pageSize: pageSize ?? PAGE_SIZE,
      allowRisky: allowRisky ?? false,
    }),
  /// Pre-execution guardrail: scan `query` for UPDATE/DELETE statements that
  /// lack a WHERE/LIMIT (whole-table operations). Returns the risky statements
  /// so the UI can confirm before running; the backend enforces this too.
  guardWriteSql: (query: string) =>
    invoke<WriteRisk[]>("guard_write_sql", { query }),
  getSchema: (connId: string, db?: string | null) =>
    invoke<Schema>("get_schema", { connId, db: db ?? null }),
  // Inline AI completion (Copilot-style): ask the LLM for the SQL suffix that
  // completes `prefix`. Returns "" when disabled / no suggestion.
  completeSql: (connId: string, db: string | null, prefix: string) =>
    invoke<string>("complete_sql", { connId, db: db ?? null, prefix }),
  getStatus: () => invoke<StatusInfo>("get_status"),
  // LLM vendor/key/model configuration (settings page).
  getLlmConfig: () => invoke<LlmConfigDto>("get_llm_config"),
  getVendorPresets: () => invoke<VendorPreset[]>("get_vendor_presets"),
  saveLlmConfig: (cfg: LlmConfigInput) =>
    invoke("save_llm_config", { input: cfg }),
  // Schema tree navigation (lazy).
  listDatabases: (connId: string) =>
    invoke<string[]>("list_databases", { connId }),
  listRedisDbs: (connId: string) =>
    invoke<number[]>("list_redis_dbs", { connId }),
  listTables: (connId: string, database: string) =>
    invoke<TableMeta[]>("list_tables", { connId, database }),
  // Lazy, bounded table search for the editor autocomplete + tree folder
  // filter. `like` is a name prefix; `limit` caps the result set so an
  // 8000-table schema never freezes the UI.
  searchTables: (
    connId: string,
    database: string,
    like: string | null,
    limit: number
  ) =>
    invoke<TableMeta[]>("search_tables", {
      connId,
      database,
      like: like ?? null,
      limit,
    }),
  listRedisKeys: (connId: string, db: number, pattern: string, limit: number) =>
    invoke<string[]>("list_redis_keys", { connId, db, pattern, limit }),
  /// List Redis keys with metadata (type, TTL, memory) in one pipeline call
  /// (ADR-025 Phase A2).
  listRedisKeysMeta: (
    connId: string,
    db: number,
    pattern: string,
    limit: number
  ) =>
    invoke<KeyMeta[]>("list_redis_keys_meta", { connId, db, pattern, limit }),
  listColumns: (connId: string, database: string, table: string) =>
    invoke<ColumnInfo[]>("list_columns", { connId, database, table }),
  browseTable: (
    connId: string,
    database: string,
    table: string,
    page: number,
    pageSize: number
  ) =>
    invoke<QueryOutput>("browse_table", { connId, database, table, page, pageSize }),
  browseRedisKey: (connId: string, db: number, key: string) =>
    invoke<QueryOutput>("browse_redis_key", { connId, db, key }),
  deleteRedisKey: (connId: string, db: number, key: string) =>
    invoke<number>("delete_redis_key", { connId, db, key }),
  phpUnserialize: (data: string) =>
    invoke<string>("php_unserialize", { data }),
  // Container (environment / group) CRUD (ADR-016). `dbType` binds the new
  // environment to MySQL/Redis so it lands under the correct root (ADR-022).
  createEnvironment: (name: string, dbType: "mysql" | "redis" = "mysql") =>
    invoke<string>("create_environment", { name, db_type: dbType }),
  createGroup: (envId: string, name: string) =>
    invoke<string>("create_group", { envId, name }),
  renameContainer: (id: string, name: string) =>
    invoke("rename_container", { id, name }),
  deleteContainer: (id: string) => invoke("delete_container", { id }),
  // EXPLAIN execution plan (MySQL only).
  explainQuery: (connId: string, query: string, db?: string | null) =>
    invoke<QueryOutput>("explain_query", { connId, query, db: db ?? "" }),
  // Query history / saved snippets.
  logQuery: (connId: string | null, db: string | null, sql: string) =>
    invoke("log_query", { connId, db, sql }),
  listQueries: () => invoke<QueryItem[]>("list_queries"),
  saveQuery: (
    id: string | null,
    name: string,
    sql: string,
    connId: string | null,
    db: string | null
  ) => invoke<string>("save_query", { id, name, sql, connId, db }),
  deleteQuery: (id: string) => invoke("delete_query", { id }),
  // Write-back a single edited row (ADR-018).
  applyEdit: (p: EditPayload) =>
    invoke("apply_edit", {
      connId: p.connId,
      database: p.database,
      table: p.table,
      pk: p.pk,
      set: p.set,
    }),
  // Insert a new row (ADR-019). `values` = only the columns the user typed.
  insertRow: (
    connId: string,
    database: string,
    table: string,
    values: Array<{ col: string; val: string }>
  ) =>
    invoke("insert_row", { connId, database, table, values }),
  // Delete a row by its primary-key snapshot (ADR-019).
  deleteRow: (
    connId: string,
    database: string,
    table: string,
    pk: Array<{ col: string; val: string }>
  ) =>
    invoke("delete_row", { connId, database, table, pk }),
  // Fetch full table structure: columns, indexes, DDL (ADR-020).
  describeTable: (connId: string, database: string, table: string) =>
    invoke<TableStructure>("describe_table", { connId, database, table }),
  // List all FK relationships in a database (ADR-021). Powers the ER view.
  listRelationships: (connId: string, database: string) =>
    invoke<ForeignKeyInfo[]>("list_relationships", { connId, database }),
  // --- Encryption key management (#0) ---
  getKeyStatus: () => invoke<KeyStatus>("get_key_status"),
  setEncryptionKey: (field: string) =>
    invoke("set_encryption_key", { field }),
  // --- Connection import / export (#1, #2) ---
  exportConnections: (cipher: "system-key" | "none") =>
    invoke<string>("export_connections", { cipher }),
  importConnections: (yaml: string) =>
    invoke<ImportResult>("import_connections", { yaml }),
  exportTemplate: () => invoke<string>("export_template"),
  // --- EXPLAIN visualisation (#6) ---
  explainVisual: (connId: string, query: string, db?: string | null) =>
    invoke<ExplainVisual>("explain_visual", { connId, query, db: db ?? "" }),
  // --- Knowledge base (ADR-AI-6): docs bound to connections / databases ---
  listKbDocs: () => invoke<KbDocDto[]>("list_kb_docs"),
  addKbDoc: (name: string, content: string) =>
    invoke<string>("add_kb_doc", { name, content }),
  updateKbDoc: (id: string, name: string, content: string) =>
    invoke("update_kb_doc", { id, name, content }),
  deleteKbDoc: (id: string) => invoke("delete_kb_doc", { id }),
  setKbBindings: (kbId: string, bindings: KbBindingInput[]) =>
    invoke("set_kb_bindings", { kbId, bindings }),
  // --- Write-guardrail audit trail (ADR-AI-1 决策3) ---
  listAuditLogs: (limit?: number) =>
    invoke<AuditRow[]>("list_audit_logs", { limit: limit ?? null }),
  // --- Conversations (docs/chat-conversation-design.md) ---
  listConversations: () => invoke<ConversationSummary[]>("list_conversations"),
  createConversation: (connId: string | null, title?: string | null) =>
    invoke<string>("create_conversation", {
      connId: connId ?? null,
      title: title ?? null,
    }),
  renameConversation: (id: string, title: string) =>
    invoke("rename_conversation", { id, title }),
  deleteConversation: (id: string) => invoke("delete_conversation", { id }),
  getConversation: (id: string, offset?: number, limit?: number) =>
    invoke<ConversationDetail>("get_conversation", {
      id,
      offset: offset ?? 0,
      limit: limit ?? 100,
    }),
  appendChatMessages: (convId: string, messages: NewChatMessage[]) =>
    invoke("append_chat_messages", { convId, messages }),
};

export function onChatToken(cb: (t: string) => void): Promise<UnlistenFn> {
  return listen<string>("chat-token", (e) => cb(e.payload));
}
export function onChatTool(cb: (t: string) => void): Promise<UnlistenFn> {
  return listen<string>("chat-tool", (e) => cb(e.payload));
}
export function onChatDone(cb: () => void): Promise<UnlistenFn> {
  return listen("chat-done", () => cb());
}
export function onChatError(cb: (t: string) => void): Promise<UnlistenFn> {
  return listen<string>("chat-error", (e) => cb(e.payload));
}
/// The orchestrator's plan, as structured steps (rendered as its own card).
export function onChatPlan(cb: (steps: string[]) => void): Promise<UnlistenFn> {
  return listen<string[]>("chat-plan", (e) => cb(e.payload));
}
/// Token cost of the turn that just ended. Emitted before `chat-done`, and
/// only by providers that report usage — absence means "unknown", not zero.
export function onChatUsage(cb: (u: TokenUsage) => void): Promise<UnlistenFn> {
  return listen<TokenUsage>("chat-usage", (e) => cb(e.payload));
}
/// A write statement the guardrail paused; the turn is blocked until answered.
export function onChatConfirm(
  cb: (req: ConfirmRequest) => void,
): Promise<UnlistenFn> {
  return listen<ConfirmRequest>("chat-confirm", (e) => cb(e.payload));
}
/// Starts a turn and resolves with its id — needed to cancel it or answer a
/// confirmation while it is still running.
///
/// `refs` is editor SQL attached to *this* turn only (ADR: Chat 引用 SQL); it is
/// never replayed as history, so a stale reference can't steer a later answer.
/// `convId` binds the turn to a persisted conversation (P0); `convRefs` carries
/// cross-conversation @-mentions (P1) whose tail messages the backend injects
/// as background context. Both are optional — the TUI path omits them.
export function chatTurn(
  connId: string,
  messages: ChatMessage[],
  refs?: SqlReference[],
  convId?: string | null,
  convRefs?: ConversationRef[],
): Promise<string> {
  return invoke<string>("chat_turn", {
    connId,
    messages,
    refs: refs && refs.length > 0 ? refs : null,
    convId: convId ?? null,
    convRefs: convRefs && convRefs.length > 0 ? convRefs : null,
  });
}
export function cancelTurn(turnId: string): Promise<void> {
  return invoke("cancel_turn", { turnId });
}
export function resolveConfirm(
  turnId: string,
  id: string,
  approved: boolean,
): Promise<void> {
  return invoke("resolve_confirm", { turnId, id, approved });
}
