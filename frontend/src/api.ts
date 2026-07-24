import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ChatMessage,
  ColumnInfo,
  ConnInput,
  EditPayload,
  ForeignKeyInfo,
  QueryItem,
  QueryOutput,
  Schema,
  StatusInfo,
  TableMeta,
  TableStructure,
  TreeModel,
} from "./types";

export const api = {
  /// Full tree model (environments → groups → connections), supersedes
  /// `list_connections`.
  listTree: () => invoke<TreeModel>("list_tree"),
  addConnection: (cfg: ConnInput) => invoke("add_connection", { cfg }),
  updateConnection: (cfg: ConnInput) => invoke("update_connection", { cfg }),
  deleteConnection: (id: string) => invoke("delete_connection", { id }),
  testConnection: (cfg: ConnInput) => invoke<boolean>("test_connection", { cfg }),
  executeQuery: (connId: string, query: string) =>
    invoke<QueryOutput>("execute_query", { connId, query }),
  getSchema: (connId: string) => invoke<Schema>("get_schema", { connId }),
  getStatus: () => invoke<StatusInfo>("get_status"),
  // Schema tree navigation (lazy).
  listDatabases: (connId: string) =>
    invoke<string[]>("list_databases", { connId }),
  listRedisDbs: (connId: string) =>
    invoke<number[]>("list_redis_dbs", { connId }),
  listTables: (connId: string, database: string) =>
    invoke<TableMeta[]>("list_tables", { connId, database }),
  listRedisKeys: (connId: string, db: number, pattern: string, limit: number) =>
    invoke<string[]>("list_redis_keys", { connId, db, pattern, limit }),
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
  // Container (environment / group) CRUD (ADR-016).
  createEnvironment: (name: string) =>
    invoke<string>("create_environment", { name }),
  createGroup: (envId: string, name: string) =>
    invoke<string>("create_group", { envId, name }),
  renameContainer: (id: string, name: string) =>
    invoke("rename_container", { id, name }),
  deleteContainer: (id: string) => invoke("delete_container", { id }),
  // EXPLAIN execution plan (MySQL only).
  explainQuery: (connId: string, query: string) =>
    invoke<QueryOutput>("explain_query", { connId, query }),
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
export function chatTurn(connId: string, messages: ChatMessage[]): Promise<void> {
  return invoke("chat_turn", { connId, messages });
}
