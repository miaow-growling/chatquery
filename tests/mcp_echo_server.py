#!/usr/bin/env python3
"""Minimal bare JSON-RPC 2.0 MCP server fixture for integration tests.

Implements only the slice of MCP that chatquery uses:
  - initialize         -> handshake result
  - tools/list         -> one echo tool
  - tools/call         -> echoes the arguments back as text
No MCP SDK required; just the stdlib, so the test stays portable.
"""
import json
import sys


def handle(obj):
    method = obj.get("method")
    req_id = obj.get("id")
    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "echo", "version": "0.0.1"},
            },
        }
    if method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "tools": [
                    {
                        "name": "echo",
                        "description": "回显参数",
                        "inputSchema": {
                            "type": "object",
                            "properties": {"msg": {"type": "string"}},
                            "required": ["msg"],
                        },
                    }
                ]
            },
        }
    if method == "tools/call":
        name = obj["params"]["name"]
        args = obj["params"].get("arguments", {})
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps(
                            {"tool": name, "args": args}, ensure_ascii=False
                        ),
                    }
                ]
            },
        }
    return None


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        # Only requests (have both method and id) get a response;
        # notifications (no id) are ignored — matching the MCP lifecycle.
        if "method" in obj and "id" in obj:
            resp = handle(obj)
            if resp is not None:
                sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
                sys.stdout.flush()


if __name__ == "__main__":
    main()
