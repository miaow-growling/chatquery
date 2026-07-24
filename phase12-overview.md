# Phase 12 概览：环境/组成为一等容器实体（空容器）

## 背景
ADR-015 把 `env`/`group` 当作连接上的派生字符串字段，树在前端聚合。用户要求 Navicat 式
"空容器"——点「新建组 / 新建环境」应立即出现一个没有任何连接的空文件夹，而不是先建
连接再"蹭"出分组。派生字段模型无法表达"无连接的组"，因此将环境/组提升为独立持久化的实体。

## 改动
- **后端领域模型** (`src/db/container.rs`)：新增 `Container { id, kind: Env|Group, name,
  parent(env_id), ord }`，连接改为 `group_id: Option<String>` 指向所属组（移除 `env`/`group`）。
- **持久化** (`src/store/mod.rs`)：新 `containers` 表；容器 CRUD；`load_connection_legacy`
  兼容旧 blob；`ConnectionStore::load` 做一次性迁移——旧连接按 `(env,group)` 合成容器并回填
  `group_id` 写回（自修复）。
- **命令** (`src-tauri/src/commands.rs`)：新增 `list_tree`（返回 `TreeModel`）、
  `create_environment`/`create_group`/`rename_container`/`delete_container`；`list_connections`
  被取代。`delete_container` 非空时拒绝，避免孤儿连接。
- **前端**：`types.ts`/`api.ts` 加 `TreeModel` 与容器 CRUD；`App.tsx` 用 `listTree`，表单
  「环境/分组」两文本框改「分组」下拉，`＋` 下拉直接落库空容器；`Tree.tsx` 消费 `TreeModel`，
  环境/组节点带 `id`，右键支持 新建组 / 重命名 / 删除。

## 验证
- `cargo check src-tauri` ✅；`cargo check --lib` + `cargo test --lib` 16/16 ✅；`npm run build` 零错。
- **需重启 `tauri dev`** 重新编译 Rust（首次加载会自动建 `containers` 表并迁移旧连接）。

## 关键取舍
- 得：真·空容器；重命名/删除为单记录操作，连接经 `group_id` 自动跟随；旧数据无缝迁移。
- 舍：比预填字段方案更重（新表+迁移+CRUD+表单/树改动），且分组仍强制嵌套在环境下。
- `ord` 排序字段已落库但未做 UI，列为后续。

详见 `ARCHITECTURE.md` 的 **ADR-016**。
