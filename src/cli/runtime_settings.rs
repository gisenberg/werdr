use std::io::{Read, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    default_shell: String,
    shell_mode: crate::config::ShellModeConfig,
    new_cwd: String,
    scrollback_limit_bytes: usize,
    worktree_directory: String,
    resume_agents_on_restore: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Update {
    revision: String,
    settings: Settings,
}

fn revision(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

fn settings(content: &str) -> Result<Settings, String> {
    let config: crate::config::Config =
        toml::from_str(content).map_err(|e| format!("Invalid native configuration: {e}"))?;
    use crate::config::NewTerminalCwdConfig;
    Ok(Settings {
        default_shell: config.terminal.default_shell,
        shell_mode: config.terminal.shell_mode,
        new_cwd: match config.terminal.new_cwd {
            NewTerminalCwdConfig::Follow => "follow".into(),
            NewTerminalCwdConfig::Home => "home".into(),
            NewTerminalCwdConfig::Current => "current".into(),
            NewTerminalCwdConfig::Path(value) => value,
        },
        scrollback_limit_bytes: config.advanced.scrollback_limit_bytes,
        worktree_directory: config.worktrees.directory,
        resume_agents_on_restore: config.session.resume_agents_on_restore,
    })
}

fn edit(content: &str, update: &Update) -> Result<String, String> {
    if update.revision != revision(content) {
        return Err("Configuration changed. Reload the settings before saving.".into());
    }
    // Reject malformed existing settings instead of silently rewriting defaults.
    settings(content)?;
    let next = &update.settings;
    for value in [&next.default_shell, &next.new_cwd, &next.worktree_directory] {
        if value.len() > 4096 || value.contains('\0') || value.contains(['\r', '\n']) {
            return Err("Runtime paths must be single-line strings of at most 4096 bytes.".into());
        }
    }
    let mut document: toml_edit::DocumentMut =
        content.parse().map_err(|e| format!("Invalid TOML: {e}"))?;
    let mode = match next.shell_mode {
        crate::config::ShellModeConfig::Auto => "auto",
        crate::config::ShellModeConfig::Login => "login",
        crate::config::ShellModeConfig::NonLogin => "non_login",
    };
    document["terminal"]["default_shell"] = toml_edit::value(&next.default_shell);
    document["terminal"]["shell_mode"] = toml_edit::value(mode);
    document["terminal"]["new_cwd"] = toml_edit::value(&next.new_cwd);
    let limit = i64::try_from(next.scrollback_limit_bytes)
        .map_err(|_| "Scrollback limit exceeds TOML integer range.")?;
    // The old name is a serde alias; retaining both would make the file invalid.
    if let Some(table) = document
        .get_mut("advanced")
        .and_then(toml_edit::Item::as_table_like_mut)
    {
        table.remove("scrollback_lines");
    }
    document["advanced"]["scrollback_limit_bytes"] = toml_edit::value(limit);
    document["worktrees"]["directory"] = toml_edit::value(&next.worktree_directory);
    document["session"]["resume_agents_on_restore"] =
        toml_edit::value(next.resume_agents_on_restore);
    let result = document.to_string();
    settings(&result)?;
    if result.len() as u64 > MAX_CONFIG_BYTES {
        return Err("Configuration exceeds one MiB.".into());
    }
    Ok(result)
}

fn read(path: &Path) -> Result<String, String> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut content = String::new();
    file.take(MAX_CONFIG_BYTES + 1)
        .read_to_string(&mut content)
        .map_err(|e| e.to_string())?;
    if content.len() as u64 > MAX_CONFIG_BYTES {
        return Err("Configuration exceeds one MiB.".into());
    }
    Ok(content)
}

fn save(path: &Path, update: &Update) -> Result<String, String> {
    let parent = path
        .parent()
        .ok_or("Configuration has no parent directory.")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let lock_path = path.with_extension("toml.runtime.lock");
    let lock = match crate::platform::create_private_state_file(&lock_path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&lock_path)
                .map_err(|e| e.to_string())?
        }
        Err(error) => return Err(error.to_string()),
    };
    lock.try_lock()
        .map_err(|_| "Another runtime settings save is in progress.")?;
    let content = read(path)?;
    let next = edit(&content, update)?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let temporary = path.with_extension(format!("toml.runtime.{}.{nonce}.tmp", std::process::id()));
    let result = (|| -> Result<(), String> {
        let mut file =
            crate::platform::create_private_state_file(&temporary).map_err(|e| e.to_string())?;
        file.write_all(next.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        if read(path)? != content {
            return Err("Configuration changed during save. Reload before saving.".into());
        }
        crate::platform::replace_file(&temporary, path).map_err(|e| e.to_string())?;
        if let Err(error) = crate::platform::sync_parent_directory(parent) {
            tracing::warn!(%error, "runtime configuration saved but directory sync failed");
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result?;
    Ok(next)
}

pub(super) fn run(args: &[String]) -> std::io::Result<i32> {
    let result = (|| -> Result<serde_json::Value, String> {
        let path = crate::config::config_path();
        let path = if path.is_absolute() {
            path
        } else {
            std::env::current_dir()
                .map_err(|e| e.to_string())?
                .join(path)
        };
        // Follow an existing user-managed config symlink rather than replacing it.
        let path = if path.exists() {
            path.canonicalize().map_err(|e| e.to_string())?
        } else {
            path
        };
        match args {
            [action] if action == "read" => {
                let content = read(&path)?;
                Ok(
                    serde_json::json!({ "revision": revision(&content), "settings": settings(&content)? }),
                )
            }
            [action] if action == "write" => {
                let mut input = String::new();
                std::io::stdin()
                    .take(32769)
                    .read_to_string(&mut input)
                    .map_err(|e| e.to_string())?;
                if input.len() > 32768 {
                    return Err("Settings request exceeds 32 KiB.".into());
                }
                let update: Update = serde_json::from_str(&input)
                    .map_err(|e| format!("Invalid runtime settings: {e}"))?;
                let content = save(&path, &update)?;
                let reload = super::send_request(&crate::api::schema::Request {
                    id: "cli:config:runtime".into(),
                    method: crate::api::schema::Method::ServerReloadConfig(
                        crate::api::schema::EmptyParams::default(),
                    ),
                })
                .unwrap_or_else(|e| serde_json::json!({ "error": { "message": e.to_string() } }));
                Ok(
                    serde_json::json!({ "saved": true, "revision": revision(&content), "settings": settings(&content)?, "reload": reload }),
                )
            }
            _ => Err("usage: herdr config runtime read|write (write reads JSON from stdin)".into()),
        }
    })();
    match result {
        Ok(result) => {
            println!("{}", serde_json::json!({ "result": result }));
            Ok(0)
        }
        Err(message) => {
            println!("{}", serde_json::json!({ "error": { "message": message } }));
            Ok(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edit_preserves_unrelated_configuration_and_rejects_stale_revision() {
        let content = "# custom configuration\n[theme]\nname = 'nord' # retain\n[advanced]\nscrollback_lines = 321\n[terminal]\nshell_mode = 'login'\n";
        let mut update = Update {
            revision: revision(content),
            settings: settings(content).unwrap(),
        };
        update.settings.default_shell = "a shell with 'quotes'".into();
        update.settings.new_cwd = "C:\\work\\project".into();
        let next = edit(content, &update).unwrap();
        assert!(next.contains("name = 'nord' # retain"));
        assert!(next.contains("# custom configuration"));
        assert!(!next.contains("scrollback_lines"));
        let parsed = settings(&next).unwrap();
        assert_eq!(parsed.default_shell, update.settings.default_shell);
        assert_eq!(parsed.new_cwd, update.settings.new_cwd);
        assert_eq!(parsed.scrollback_limit_bytes, 321);
        assert!(edit(&next, &update).is_err());
    }

    #[test]
    fn atomic_save_rejects_stale_writers_and_preserves_invalid_files() {
        let directory = std::env::temp_dir().join(format!(
            "herdr-runtime-settings-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = directory.join("config.toml");
        let update = Update {
            revision: revision(""),
            settings: settings("").unwrap(),
        };
        let saved = save(&path, &update).unwrap();
        assert_eq!(read(&path).unwrap(), saved);
        assert!(save(&path, &update).is_err());
        assert_eq!(read(&path).unwrap(), saved);
        let invalid = "[terminal]\nshell_mode = 'invalid'";
        std::fs::write(&path, invalid).unwrap();
        let invalid_update = Update {
            revision: revision(invalid),
            settings: update.settings,
        };
        assert!(save(&path, &invalid_update).is_err());
        assert_eq!(read(&path).unwrap(), invalid);
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 2);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn invalid_config_and_settings_fail_before_editing() {
        assert!(settings("[terminal]\nshell_mode='invalid'").is_err());
        let mut update = Update {
            revision: revision(""),
            settings: settings("").unwrap(),
        };
        update.settings.default_shell = "bad\npath".into();
        assert!(edit("", &update).is_err());
    }
}
