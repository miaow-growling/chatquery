<div align="center">

<img src="ui-design/chatquery-icon.svg" width="96" height="96" alt="ChatQuery Logo" />

# ChatQuery (智询)

**Modern, Lightweight, AI-Native Database Workspace & Intelligence Hub**  
*A local-first, multi-model database client and MCP server for MySQL & Redis.*

<p align="center">
  <a href="README.md"><b>English</b></a> •
  <a href="README_CN.md">简体中文</a>
</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20|%20Windows%20|%20Linux-lightgrey.svg)]()
[![Rust](https://img.shields.io/badge/Rust-1.78+-orange.svg)](https://www.rust-lang.org/)
[![Tauri](https://img.shields.io/badge/Tauri-v2-24C8DB.svg)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-18-61DAFB.svg)](https://react.dev/)

[Features](#-key-features) •
[Quick Start](#-download--installation) •
[MCP Integration](#-mcp-server--ai-ide-integration) •
[Development](#-local-development--build) •
[Security & Privacy](#-privacy--security-by-design) •
[Architecture](#-project-architecture)

</div>

---

## 📖 Introduction

**ChatQuery** is a **local-first, AI-native database client and workspace** engineered for developers, DBAs, and data analysts. Moving away from bloated, memory-heavy legacy GUI tools, ChatQuery is powered by a high-performance **Rust** core and **Tauri v2** desktop framework, coupled with a professional **Monaco Editor (VS Code kernel)** frontend.

Beyond blazing-fast visual browsing and querying for **MySQL** and **Redis**, ChatQuery natively incorporates a **Multi-Agent planning system**, **SQL Guard safety guardrails**, **dynamic business correction memories**, and standard **MCP (Model Context Protocol)** server capabilities.

<div align="center">
  <img src="ui-design/screenshots/plan-B.png" width="90%" alt="ChatQuery Desktop Workspace" style="border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.15);" />
</div>

---

## ⚡ Key Features

### 1. Ultra-Lightweight & Native Performance
- **Minimal Resource Footprint**: Built with Rust and Tauri v2. Consumes over 80% less memory than conventional Electron-based database managers with sub-second cold starts.
- **Modern Adaptive UI**: Responsive dark/light themes, spring-physics micro-interactions, macOS Finder-styled hierarchical connection tree, and multi-tab workspace.

### 2. Comprehensive MySQL Management & Diagnostics
- **IntelliSense SQL Editor**: Powered by the Monaco Editor with SQL syntax highlighting, intelligent auto-completions, formatting, and cursor-targeted single statement execution.
- **In-Place Cell Editing**: Spreadsheet-like inline grid editing (INSERT / UPDATE / DELETE) with primary-key-based atomic write-backs and concurrency conflict awareness.
- **Visual EXPLAIN Analysis**: One-click execution plan visualizer to diagnose query bottlenecks, index coverage, and table scan costs.
- **Mermaid ER Diagrams**: Automatic detection of foreign keys and relational schemas, rendered into interactive zoomable/pannable entity diagrams with SVG export.
- **External Configuration Import**: Seamlessly import connection profiles and JDBC URLs from Navicat, DataGrip, and DBeaver.

### 3. Dedicated Redis Key Browser (RDM-Style)
- **Hierarchical Key Trees**: Delimited namespace folding (`:`) to navigate millions of keys effortlessly.
- **Rich Data Structures**: Native view, search, and edit support for String, Hash, List, Set, and ZSet.
- **PHP Unserialize Viewer**: Dedicated decoder to turn classic PHP-serialized session and cache blobs into formatted, readable JSON in one click.
- **Live TTL Monitoring**: Visual expiration countdown with quick renew or persist actions.

### 4. Deep AI Multi-Agent & Dynamic Memory
- **Extensive Model Provider Matrix**: Pre-configured support for leading AI models (OpenAI, Anthropic Claude, DeepSeek, Qwen/DashScope, GLM/Zhipu, Moonshot Kimi, Doubao, Ollama local offline models, and custom OpenAI-compatible endpoints).
- **Multi-Agent Orchestration**: Built-in specialized roles (Planner, Explorer, Executor) with full-lifecycle Langfuse-compatible waterfall Gantt trace inspection.
- **SQL Guard Safety Engine**: Tri-tier operational policy (`Allow` / `ConfirmRequired` / `Deny`) preventing unintended `DROP`, unconstrained `UPDATE`, and destructive DDL.
- **Self-Healing Business Memory**: Dynamically extracts organizational context and correction rules from dialogue (e.g., *"This table requires status=1"*, *"Use code rather than key"*), automatically priming future queries to eliminate repetitive errors.

### 5. Tri-Form Architecture: GUI · CLI · MCP Server
- **GUI Desktop**: Clean, visual daily workspace.
- **Standalone CLI**: Bundled `chatquery` binary providing connection management, ad-hoc queries, Redis inspection, and schema dump capabilities.
- **Standard MCP Server**: Exposes database topology, schema metadata, and safe read-only queries as standard tools over stdio to external AI IDEs (Claude Desktop, Cursor, Windsurf, ZCode, etc.).

### 6. End-to-End Encryption & Git Sync
- **AES-256-GCM + HKDF-SHA256**: All connection credentials and API keys are encrypted at rest locally; zero plaintext leaks.
- **Private Git Synchronization**: Synchronize connection configs, model presets, and code snippets end-to-end encrypted to your private Git repository.

---

## 🚀 Download & Installation

Visit the [Releases Page](https://github.com/miaow-growling/chatquery/releases) to download pre-built binaries for your platform:

| Operating System | Architecture | Package Format | Details |
| :--- | :--- | :--- | :--- |
| **macOS** | Apple Silicon (M1/M2/M3/M4) | `.dmg` | Native arm64 binary |
| **macOS** | Intel x64 | `.dmg` | Universal legacy Intel Mac package |
| **Windows** | Windows 10/11 x64 | `.exe` (NSIS) | Guided installer |
| **Windows** | Windows 10/11 x64 | `.exe` (Portable) | Standalone portable green edition |
| **Linux** | Ubuntu / Debian / x64 | `.AppImage` / `.deb` | Cross-distro packages |

---

## 🔌 MCP Server & AI IDE Integration

ChatQuery features a built-in **Model Context Protocol (MCP)** server, enabling assistants like Claude Desktop, Cursor, or Windsurf to safely explore and query your databases.

### Configuration for Claude Desktop or Cursor:

Add ChatQuery to your MCP configuration file (`claude_desktop_config.json` or `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "chatquery": {
      "command": "/Applications/智询.app/Contents/MacOS/chatquery",
      "args": ["mcp"]
    }
  }
}
```

*(On Windows, replace `command` with the absolute path to `chatquery.exe`)*

### Tools Provided by ChatQuery MCP:
- `cq_list_topology`: Lists all configured database environments, groups, and connections.
- `cq_get_prompt_context`: Retrieves exact schema definitions, table comments, and historical business memories for SQL generation.
- `cq_execute_query`: Executes guarded read-only SQL queries against selected connections.
- `cq_redis_get` / `cq_redis_keys`: Reads Redis keys and auto-deserializes complex values.
- `cq_add_memory` / `cq_list_memories`: Inspects and persists business-specific query conventions.

---

## 🛠️ Local Development & Build

### Prerequisites
- **Rust** 1.78+ (`rustup update stable`)
- **Node.js** 20.x+ (`node -v`)
- **npm** or **pnpm**
- OS build dependencies (Linux requires `libwebkit2gtk-4.1-dev`, etc.)

### 1. Clone Repository
```bash
git clone git@github.com:miaow-growling/chatquery.git
cd chatquery
```

### 2. Install Frontend Dependencies
```bash
cd frontend
npm install
cd ..
```

### 3. Launch Development Mode
```bash
# Start Tauri desktop hot-reload development
npm run dev
```

### 4. Run Rust Test Suite
```bash
cargo test --lib
```

### 5. Build Release Packages
```bash
# Compiles binaries and packages them into src-tauri/target/release/bundle
npm run build
```

---

## 🔒 Privacy & Security by Design

1. **Zero Data Telemetry**: ChatQuery does not maintain telemetry servers to collect database contents. All SQL operations, schema inspections, and results remain strictly between your local client and your target database.
2. **Two-Layer Cryptographic Model**:
   - Machine Key (KEK): Dynamically initialized at runtime and stored locally with strict `0600` permissions.
   - Credentials Key (K): Deterministically derived using HKDF-SHA256 to encrypt connection passwords and LLM keys via AES-256-GCM.
3. **Mandatory Read-Only Gatekeeper**: Queries executed via MCP default to strict read-only mode, proactively rejecting DML updates, deletes, and DDL mutations.

---

## 📂 Project Architecture

```text
chatquery/
├── src/                    # Rust core library (drivers, LLM, MCP, security policy)
│   ├── cli/                # CLI subcommands & Stdio MCP Server
│   ├── db/                 # MySQL pool, Redis client, config import/export
│   ├── llm/                # Agent orchestration, Langfuse trace, guardrails, memory
│   ├── crypto.rs           # AES-256-GCM + HKDF cryptographic layer
│   └── store/              # Local SQLite metadata persistence
├── src-tauri/              # Tauri v2 desktop shell (IPC bridge, menus, packaging)
├── frontend/               # React 18 + TypeScript + Monaco Editor frontend
│   ├── src/
│   │   ├── components/     # Mermaid diagrams, AI trace, memory modals, data assistant
│   │   ├── monaco-sql.ts   # VS Code Monaco Editor SQL grammar & completions
│   │   └── App.tsx         # Primary workspace layout & event bus
├── scripts/                # Packaging, cross-compilation & release scripts
├── website/                # Official product landing page & downloads
└── docs/                   # Architecture decisions, security specs & release guides
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE). Contributions, bug reports, and pull requests are warmly welcomed!
