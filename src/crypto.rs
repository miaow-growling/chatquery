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
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::io::Write;
#[cfg(unix)]
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
    #[cfg(unix)]
    {
        let mut perms = std::fs::metadata(&path)?.permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(&path, perms)?;
    }
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

// --- Two-layer key model (#0: 系统配置·加密密钥) -----------------------------
//
// KEK (machine key): generated once, stored in `~/.config/chatquery/key` (0600),
//   machine-bound, never exported. Used to (a) encrypt K at rest, (b) encrypt
//   the LLM api_key, (c) serve as the *default* K when no user key is set.
// K (configurable key): derived deterministically from a user-supplied key
//   field via HKDF-SHA256. Because it's reproducible, the same field on two
//   machines yields the same K, so connection passwords exported under K
//   decrypt on the other machine without a per-export passphrase.

/// Hardcoded salt so K is reproducible across machines given the same key field.
/// NOT a secret — its only job is domain separation for the HKDF.
pub const APP_FIXED_SALT: &[u8] = b"chatquery::conn-key::v1::salt";
const KEY_DERIVE_INFO: &[u8] = b"chatquery:conn-key:v1";
/// Constant plaintext used to mint the verification token — lets us confirm a
/// typed key field matches the stored K without ever round-tripping a real secret.
const VERIFY_TOKEN_PLAIN: &str = "chatquery::key-verify::v1";

/// Derive the connection-encryption key K from a user-supplied key field.
///
/// - Empty field → K degenerates to the machine key (KEK). Behaviour is then
///   identical to before this feature existed: zero-config, fully compatible.
/// - Non-empty field → `K = HKDF-SHA256(salt=APP_FIXED_SALT, info, ikm=field)`.
///   Deterministic, so the same field on two machines yields the same K and an
///   exported ciphertext decrypts (cross-machine portability).
pub fn derive_key(field: &str) -> Result<[u8; 32]> {
    if field.is_empty() {
        return load_key();
    }
    let hk = Hkdf::<Sha256>::new(Some(APP_FIXED_SALT), field.as_bytes());
    let mut okm = [0u8; 32];
    hk.expand(KEY_DERIVE_INFO, &mut okm)
        .map_err(|e| AppError::Msg(format!("hkdf expand: {}", e)))?;
    Ok(okm)
}

/// On-disk key-config shape. `key_enc` is K (base64 → AES-GCM with the KEK);
/// `token` is `VERIFY_TOKEN_PLAIN` AES-GCM-encrypted with K so we can confirm a
/// typed field matches the stored K.
#[derive(Serialize, Deserialize)]
struct KeyConfigFile {
    key_enc: String,
    token: String,
}

/// Load the connection-encryption key K:
/// - keycfg.json present → decrypt `key_enc` (AES-GCM, KEK) → K.
/// - absent → K = `derive_key("")` = KEK (unconfigured; backward compatible).
pub fn load_encryption_key() -> Result<[u8; 32]> {
    let path = keycfg_path();
    if !path.exists() {
        return derive_key("");
    }
    let text = std::fs::read_to_string(&path)?;
    let f: KeyConfigFile = serde_json::from_str(&text)
        .map_err(|e| AppError::Msg(format!("keycfg parse: {}", e)))?;
    let kek = load_key()?;
    let k_b64 = decrypt(&f.key_enc, &kek)?;
    let bytes = STANDARD
        .decode(k_b64.trim())
        .map_err(|e| AppError::Msg(format!("keycfg key decode: {}", e)))?;
    if bytes.len() != 32 {
        return Err(AppError::Msg("keycfg key length invalid".into()));
    }
    let mut k = [0u8; 32];
    k.copy_from_slice(&bytes);
    Ok(k)
}

/// Persist K derived from `field` into keycfg.json (KEK-encrypted). K itself
/// never leaves the machine in plaintext. Returns the derived K so the caller
/// can rotate the on-disk store to it.
pub fn save_key_config(field: &str) -> Result<[u8; 32]> {
    let k = derive_key(field)?;
    let kek = load_key()?;
    let k_b64 = STANDARD.encode(k);
    let key_enc = encrypt(&k_b64, &kek)?;
    let token = encrypt(VERIFY_TOKEN_PLAIN, &k)?;
    let f = KeyConfigFile { key_enc, token };
    let path = keycfg_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let bytes = serde_json::to_vec_pretty(&f)?;
    std::fs::write(&path, bytes)?;
    // 0600 — keycfg holds the machine-bound K ciphertext.
    #[cfg(unix)]
    if let Ok(mut perms) = std::fs::metadata(&path).map(|m| m.permissions()) {
        perms.set_mode(0o600);
        let _ = std::fs::set_permissions(&path, perms);
    }
    Ok(k)
}

/// Confirm a typed key field matches the stored K. Returns false when no key
/// is configured yet (nothing to verify against) or the field is wrong.
pub fn verify_key(field: &str) -> Result<bool> {
    let path = keycfg_path();
    if !path.exists() {
        return Ok(false);
    }
    let k = derive_key(field)?;
    let text = std::fs::read_to_string(&path)?;
    let f: KeyConfigFile = serde_json::from_str(&text)
        .map_err(|e| AppError::Msg(format!("keycfg parse: {}", e)))?;
    match decrypt(&f.token, &k) {
        Ok(t) => Ok(t == VERIFY_TOKEN_PLAIN),
        Err(_) => Ok(false),
    }
}

/// Path to the on-disk key config (`~/.config/chatquery/keycfg.json`).
fn keycfg_path() -> PathBuf {
    let dir = config_dir();
    let _ = std::fs::create_dir_all(&dir);
    dir.join("keycfg.json")
}

/// Whether a configurable key K has been set (keycfg.json exists).
pub fn key_configured() -> bool {
    keycfg_path().exists()
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
