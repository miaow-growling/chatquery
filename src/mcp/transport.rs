use crate::error::{AppError, Result};
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// A line-delimited JSON-RPC 2.0 channel over a child process's stdio.
///
/// Requests are written as one JSON object + `\n` to stdin. Responses and
/// notifications arrive as one JSON object + `\n` on stdout; a background
/// reader thread forwards each line to an in-process mpsc channel so `recv_*`
/// can poll with a timeout on the main thread.
pub struct StdioTransport {
    stdin: ChildStdin,
    line_rx: mpsc::Receiver<String>,
    child: Child,
}

type ChildStdin = std::process::ChildStdin;

impl StdioTransport {
    /// Spawn the server process with piped stdio. stderr is discarded so a
    /// chatty server can't flood our terminal.
    pub fn spawn(cmd: &str, args: &[String]) -> Result<Self> {
        let mut command = Command::new(cmd);
        command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command.spawn().map_err(|e| {
            AppError::Msg(format!("无法启动 MCP server '{}': {}", cmd, e))
        })?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");

        let (tx, rx) = mpsc::channel::<String>();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(l) if !l.trim().is_empty() => {
                        if tx.send(l).is_err() {
                            break; // receiver dropped; process is gone
                        }
                    }
                    _ => break,
                }
            }
        });

        Ok(Self {
            stdin,
            line_rx: rx,
            child,
        })
    }

    /// Write one JSON-RPC message followed by a newline.
    pub fn send(&mut self, msg: &Value) -> Result<()> {
        let mut s = serde_json::to_string(msg).map_err(AppError::Json)?;
        s.push('\n');
        self.stdin.write_all(s.as_bytes())?;
        self.stdin.flush()?;
        Ok(())
    }

    /// Block until a response with the given `id` arrives (skipping any
    /// notifications that carry no id). Returns the parsed JSON value.
    pub fn recv_response(&self, want_id: u64, timeout: Duration) -> Result<Value> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let line = match self.line_rx.recv_timeout(remaining) {
                Ok(l) => l,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    return Err(AppError::Msg("MCP 响应超时".into()))
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(AppError::Msg("MCP server 进程已退出".into()))
                }
            };
            let v: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue, // ignore malformed line
            };
            // Skip notifications (no id field).
            let id = match v.get("id").and_then(|x| x.as_u64()) {
                Some(id) => id,
                None => continue,
            };
            if id != want_id {
                continue;
            }
            if let Some(err) = v.get("error") {
                return Err(AppError::Msg(format!("MCP error: {}", err)));
            }
            return Ok(v);
        }
    }

    /// Best-effort kill of the child process.
    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for StdioTransport {
    fn drop(&mut self) {
        self.kill();
    }
}
