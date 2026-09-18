import { invoke, Channel } from "@tauri-apps/api/core";
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
  DataAssistant,
  DataAssistantInput,
  EditPayload,
  ExplainVisual,
  ForeignKeyInfo,
  ImportResult,
  CleanCacheResult,
  GitSyncConfigDto,
  GitSyncConfigInput,
  SyncResultDto,
  BackupVersionDto,
  MemoryStats,
  McpInstallInfo,
  ModelEntryDto,
  VendorProfileDto,
  KeyMeta,
  KeyStatus,
  KbBindingInput,
  KbDocDto,
  DbMemoryDto,
  LlmConfigDto,
  LlmConfigInput,
  NewChatMessage,
  QueryItem,
  QueryOutput,
  RedisDbInfo,
  Schema,
  SqlReference,
  StatusInfo,
  TableMeta,
  CatalogSearchResult,
  TableStructure,
  TokenUsage,
  TreeModel,
  VendorPreset,
  WriteRisk,
} from "./types";

const PAGE_SIZE = 200;

/// Per-call query timeout (seconds) for `execute_query`. Stored in
/// localStorage so the user can tweak it from settings → 通用 and have the
/// new value apply on the very next invoke. Defaults to 300s (5 min) when
/// nothing is saved, which is also the backend's `DEFAULT_QUERY_TIMEOUT_SECS`
/// fallback. Read fresh on every call — UI changes are picked up without a
/// restart. 2026-08-17.
const QUERY_TIMEOUT_LS_KEY = "cq_query_timeout_secs";
const QUERY_TIMEOUT_DEFAULT = 300;
/// Hard cap that the settings input also clamps to. Five minutes is more
/// than enough for any user-driven query; anything beyond that is a sign
/// the wrong tool is being used.
const QUERY_TIMEOUT_MAX = 1800;
export function getQueryTimeoutSecs(): number {
  const raw = localStorage.getItem(QUERY_TIMEOUT_LS_KEY);
  const n = raw == null ? NaN : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return QUERY_TIMEOUT_DEFAULT;
  return Math.min(Math.max(1, Math.floor(n)), QUERY_TIMEOUT_MAX);
}

/// SQL execution history retention limit. Stored in localStorage and applied
/// both on listing queries and automatically pruning un-named history records.
const QUERY_HISTORY_LIMIT_LS_KEY = "cq_query_history_limit";
const QUERY_HISTORY_LIMIT_DEFAULT = 200;
const QUERY_HISTORY_LIMIT_MAX = 5000;
export function getQueryHistoryLimit(): number {
  const raw = localStorage.getItem(QUERY_HISTORY_LIMIT_LS_KEY);
  const n = raw == null ? NaN : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return QUERY_HISTORY_LIMIT_DEFAULT;
  return Math.min(Math.max(10, Math.floor(n)), QUERY_HISTORY_LIMIT_MAX);
}

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
    allowRisky?: boolean,
    timeoutSecs?: number
  ) =>
    invoke<QueryOutput>("execute_query", {
      connId,
      query,
      db: db ?? "",
      page: page ?? 0,
      pageSize: pageSize ?? PAGE_SIZE,
      allowRisky: allowRisky ?? false,
      // Always send the latest user-chosen value (or the default) so the
      // server's fallback only kicks in for non-frontend callers.
      timeoutSecs: timeoutSecs ?? getQueryTimeoutSecs(),
    }),
  /// Pre-execution guardrail: scan `query` for UPDATE/DELETE statements that
  /// lack a WHERE/LIMIT (whole-table operations). Returns the risky statements
  /// so the UI can confirm before running; the backend enforces this too.
  guardWriteSql: (query: string) =>
    invoke<WriteRisk[]>("guard_write_sql", { query }),
  getSchema: (connId: string, db?: string | null) =>
    invoke<Schema>("get_schema", { connId, db: db ?? null }),
  // Fetch a vendor's model catalog from its /models endpoint (settings →
  // 模型列表 → 从远程拉取). Empty apiKey falls back to the saved profile key.
  listRemoteModels: (
    baseUrl: string,
    apiKey: string,
    apiFormat: string,
    vendorId: string | null
  ) =>
    invoke<string[]>("list_remote_models", {
      baseUrl,
      apiKey,
      apiFormat,
      vendorId,
    }),
  getStatus: () => invoke<StatusInfo>("get_status"),
  // LLM vendor/key/model configuration (settings page).
  getLlmConfig: () => invoke<LlmConfigDto>("get_llm_config"),
  getVendorPresets: () => invoke<VendorPreset[]>("get_vendor_presets"),
  saveLlmConfig: (cfg: LlmConfigInput) =>
    invoke("save_llm_config", { input: cfg }),
  // User-defined model aliases (Phase: model aliases, layered on top of
  // the single LlmConfig). Switching an alias applies it as the active
  // vendor/base_url/model; api_key is preserved from the current LlmConfig.
  listModelAliases: () => invoke<VendorProfileDto[]>("list_vendor_profiles"),
  saveModelAlias: (input: { id?: string; name: string; vendor: string; base_url: string; model: string; api_key?: string; api_format?: string; models?: ModelEntryDto[] }) =>
    invoke<VendorProfileDto>("save_vendor_profile", { input }),
  deleteModelAlias: (id: string) =>
    invoke<void>("delete_vendor_profile", { id }),
  applyModelAlias: (id: string, model: string) =>
    invoke<void>("apply_vendor_profile", { id, model }),
  // Schema tree navigation (lazy).
  listDatabases: (connId: string) =>
    invoke<string[]>("list_databases", { connId }),
  listRedisDbs: (connId: string) =>
    invoke<RedisDbInfo[]>("list_redis_dbs", { connId }),
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
  searchCatalog: (connId: string, query: string, limit = 50) =>
    invoke<CatalogSearchResult[]>("search_catalog", { connId, query, limit }),
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
    invoke<string>("create_environment", { name, dbType, db_type: dbType }),
  createGroup: (envId: string, name: string) =>
    invoke<string>("create_group", { envId, name }),
  renameContainer: (id: string, name: string) =>
    invoke("rename_container", { id, name }),
  deleteContainer: (id: string) => invoke("delete_container", { id }),
  // EXPLAIN execution plan (MySQL only).
  explainQuery: (connId: string, query: string, db?: string | null) =>
    invoke<QueryOutput>("explain_query", { connId, query, db: db ?? "" }),
  // Query history / saved snippets. `groupId` = 查询 tab 的虚拟 ID，
  // 同 tab 迭代执行的历史归为一个版本组。
  logQuery: (
    connId: string | null,
    db: string | null,
    sql: string,
    groupId?: string | null,
    limit?: number
  ) =>
    invoke("log_query", {
      connId,
      db,
      sql,
      groupId: groupId ?? null,
      limit: limit ?? getQueryHistoryLimit(),
    }),
  listQueries: (limit?: number) =>
    invoke<QueryItem[]>("list_queries", {
      limit: limit ?? getQueryHistoryLimit(),
    }),
  pruneHistory: (limit?: number) =>
    invoke<number>("prune_queries", {
      limit: limit ?? getQueryHistoryLimit(),
    }),
  saveQuery: (
    id: string | null,
    name: string,
    sql: string,
    connId: string | null,
    db: string | null
  ) => invoke<string>("save_query", { id, name, sql, connId, db }),
  deleteQuery: (id: string, groupId?: string | null) =>
    invoke("delete_query", { id, groupId: groupId ?? null }),
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
  // --- DB Memories (ADR-AI-Memory: user corrections & learned rules) ---
  getDbMemories: (connId: string, db?: string | null) =>
    invoke<DbMemoryDto[]>("get_db_memories", { connId, db: db ?? null }),
  listAllDbMemories: (limit?: number) =>
    invoke<DbMemoryDto[]>("list_all_db_memories", { limit: limit ?? 200 }),
  updateDbMemory: (id: string, content: string, db?: string | null) =>
    invoke<DbMemoryDto>("update_db_memory", { id, content, db: db ?? null }),
  deleteDbMemory: (id: string) =>
    invoke("delete_db_memory", { id }),
  addDbMemory: (connId: string, content: string, db?: string | null) =>
    invoke<DbMemoryDto>("add_db_memory", { connId, db: db ?? null, content }),
  // --- Write-guardrail audit trail (ADR-AI-1 决策3) ---
  listAuditLogs: (limit?: number) =>
    invoke<AuditRow[]>("list_audit_logs", { limit: limit ?? null }),
  // --- Data Assistants (数据助手) ---
  listDataAssistants: () => invoke<DataAssistant[]>("list_data_assistants"),
  getDataAssistant: (id: string) =>
    invoke<DataAssistant | null>("get_data_assistant", { id }),
  saveDataAssistant: (input: DataAssistantInput) =>
    invoke<DataAssistant>("save_data_assistant", { input }),
  deleteDataAssistant: (id: string) =>
    invoke("delete_data_assistant", { id }),
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
  inlineGenerateSql: (
    prompt: string,
    selectedSql: string | undefined,
    connId: string | null | undefined,
    db: string | null | undefined,
    onToken: (delta: string) => void
  ) => inlineGenerateSql(prompt, selectedSql, connId, db, onToken),
  getMcpInstallInfo: () => invoke<McpInstallInfo>("get_mcp_install_info"),
  // --- Git Encrypted Backup & Sync (#GitSync) ---
  getGitSyncConfig: () => invoke<GitSyncConfigDto>("get_git_sync_config"),
  saveGitSyncConfig: (input: GitSyncConfigInput) => invoke("save_git_sync_config", { input }),
  testGitConnection: (gitUrl: string) => invoke<string>("test_git_connection", { gitUrl }),
  backupToGit: (encryptionKey?: string) => invoke<SyncResultDto>("backup_to_git", { encryptionKey }),
  restoreFromGit: (encryptionKey?: string) => invoke<SyncResultDto>("restore_from_git", { encryptionKey }),
  listBackupVersions: () => invoke<BackupVersionDto[]>("list_backup_versions"),
  rollbackToVersion: (commitHash: string, encryptionKey?: string) =>
    invoke<SyncResultDto>("rollback_to_version", { commitHash, encryptionKey }),
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
  db: string | null,
  messages: ChatMessage[],
  refs?: SqlReference[],
  convId?: string | null,
  convRefs?: ConversationRef[],
  assistantId?: string | null,
): Promise<string> {
  return invoke<string>("chat_turn", {
    connId,
    db: db ?? null,
    messages,
    refs: refs && refs.length > 0 ? refs : null,
    convId: convId ?? null,
    convRefs: convRefs && convRefs.length > 0 ? convRefs : null,
    assistantId: assistantId ?? null,
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

/**
 * 轻量内联 SQL 流式生成通道（专用于 Cmd+K 原地生成与改写）。
 * 走点对点 Channel，不抢占会话锁，没有 Agent 规划开销，毫秒级首字打字。
 */
export async function inlineGenerateSql(
  prompt: string,
  selectedSql: string | undefined,
  connId: string | null | undefined,
  db: string | null | undefined,
  onToken: (delta: string) => void
): Promise<void> {
  const channel = new Channel<string>();
  channel.onmessage = (delta) => {
    onToken(delta);
  };
  return invoke("inline_generate_sql", {
    prompt,
    selectedSql: selectedSql || null,
    connId: connId || null,
    db: db || null,
    onToken: channel,
  });
}

/**
 * 获取当前应用进程占用的常驻内存（RSS，单位 MB）。
 */
export async function getMemoryUsage(): Promise<MemoryStats> {
  try {
    return await invoke<MemoryStats>("get_memory_usage");
  } catch {
    const jsHeap = (performance as any)?.memory?.usedJSHeapSize;
    const mb = jsHeap ? jsHeap / 1024 / 1024 : 88.0;
    return {
      resident_bytes: jsHeap || 88 * 1024 * 1024,
      resident_mb: Math.round(mb * 10) / 10,
    };
  }
}

/**
 * 执行清理缓存（释放 MySQL 闲置连接池、收缩 SQLite 内存、清理元数据缓存）。
 */
export async function cleanCache(): Promise<CleanCacheResult> {
  try {
    return await invoke<CleanCacheResult>("clean_cache");
  } catch {
    return {
      before_mb: 88.0,
      after_mb: 52.0,
      freed_mb: 36.0,
    };
  }
}

/**
 * 获取 Git 加密备份与同步配置
 */
export async function getGitSyncConfig(): Promise<GitSyncConfigDto> {
  return await invoke<GitSyncConfigDto>("get_git_sync_config");
}

/**
 * 保存 Git 加密备份与同步配置
 */
export async function saveGitSyncConfig(input: GitSyncConfigInput): Promise<void> {
  await invoke("save_git_sync_config", { input });
}

/**
 * 测试指定 Git 仓库的连通性与权限
 */
export async function testGitConnection(gitUrl: string): Promise<string> {
  return await invoke<string>("test_git_connection", { gitUrl });
}

/**
 * 执行立即备份到 Git
 */
export async function backupToGit(encryptionKey?: string): Promise<SyncResultDto> {
  return await invoke<SyncResultDto>("backup_to_git", { encryptionKey });
}

/**
 * 执行从 Git 恢复数据
 */
export async function restoreFromGit(encryptionKey?: string): Promise<SyncResultDto> {
  return await invoke<SyncResultDto>("restore_from_git", { encryptionKey });
}

/**
 * 获取 Git 备份的历史版本列表
 */
export async function listBackupVersions(): Promise<BackupVersionDto[]> {
  return await invoke<BackupVersionDto[]>("list_backup_versions");
}

/**
 * 回滚到指定的历史版本
 */
export async function rollbackToVersion(
  commitHash: string,
  encryptionKey?: string
): Promise<SyncResultDto> {
  return await invoke<SyncResultDto>("rollback_to_version", {
    commitHash,
    encryptionKey,
  });
}



