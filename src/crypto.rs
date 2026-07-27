//! At-rest encryption for persisted connection configs (ADR-004).
//!
//! Connection records (host / user / password) are encrypted with AES-256-GCM
//! before being written to SQLite. The 32-byte key lives in a separate file
//! (`key`) under the config dir with `0600` perms, so a leaked or synced
//! `app.db` alone does not expose credentials in plaintext.
//!
//! Threat model (honest scope): this protects against *passive* disclosure —
//! e.g. committing `app.db` to git, including it in a backup, or sharing the
//! file. It does NOT protect against an attacker who already has the user's
//! account (they can read both the key and the DB). For that you'd want an OS
//! keychain (macOS Keychain / libsecret), which is a future option.

use crate::error::{AppError, Result};
use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

const NONCE_LEN: usize = 12;

/// Load the 32-byte key, creating it on first run (stored with 0600 perms).
pub fn load_key() -> Result<[u8; 32]> {
    let path = key_path();
    if path.exists() {
        let bytes = std::fs::read(&path)?;
        if bytes.len() == 32 {
            let mut k = [0u8; 32];
            k.copy_from_slice(&bytes);
            return Ok(k);
        }
    }
    let mut k = [0u8; 32];
    getrandom::getrandom(&mut k).map_err(|e| AppError::Msg(format!("getrandom: {}", e)))?;
    let mut f = std::fs::File::create(&path)?;
    f.write_all(&k)?;
    let mut perms = std::fs::metadata(&path)?.permissions();
    perms.set_mode(0o600);
    std::fs::set_permissions(&path, perms)?;
    Ok(k)
}

/// Encrypt a UTF-8 string as `base64(nonce || ciphertext)`.
pub fn encrypt(plaintext: &str, key: &[u8; 32]) -> Result<String> {
    let cipher = Aes256Gcm::new_from_slice(key).expect("key is 32 bytes");
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::getrandom(&mut nonce).map_err(|e| AppError::Msg(format!("getrandom: {}", e)))?;
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext.as_bytes())
        .map_err(|e| AppError::Msg(format!("encrypt: {}", e)))?;
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(STANDARD.encode(out))
}

/// Decrypt a `base64(nonce || ciphertext)` string back to UTF-8.
pub fn decrypt(b64: &str, key: &[u8; 32]) -> Result<String> {
    let raw = STANDARD
        .decode(b64)
        .map_err(|e| AppError::Msg(format!("base64 decode: {}", e)))?;
    if raw.len() < NONCE_LEN {
        return Err(AppError::Msg("ciphertext too short".into()));
    }
    let (nonce, ct) = raw.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new_from_slice(key).expect("key is 32 bytes");
    let pt = cipher
        .decrypt(Nonce::from_slice(nonce), ct)
        .map_err(|e| AppError::Msg(format!("decrypt: {}", e)))?;
    String::from_utf8(pt).map_err(|e| AppError::Msg(format!("utf8: {}", e)))
}

fn key_path() -> PathBuf {
    let dir = config_dir();
    let _ = std::fs::create_dir_all(&dir);
    dir.join("key")
}

pub(crate) fn config_dir() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        return PathBuf::from(xdg).join("chatquery");
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".config").join("chatquery")
}
