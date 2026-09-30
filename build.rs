use sha2::{Digest, Sha256};
use std::path::Path;

/// Identify the vendored libghostty snapshot codec. Its binary snapshot format
/// has no cross-version guarantee, so live handoff transfers exact terminal
/// state only between builds whose vendored source and local patch set match.
fn terminal_state_codec() -> String {
    let manifest = Path::new("vendor/libghostty-vt.vendor.json");
    let patches = Path::new("vendor/patches/libghostty-vt");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rerun-if-changed={}", patches.display());
    let mut digest = Sha256::new();
    let manifest_bytes = std::fs::read(manifest).unwrap_or_default();
    digest.update(&manifest_bytes);
    let mut entries: Vec<_> = std::fs::read_dir(patches)
        .map(|entries| entries.filter_map(Result::ok).map(|e| e.path()).collect())
        .unwrap_or_default();
    entries.sort();
    for path in entries {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        digest.update((name.len() as u64).to_le_bytes());
        digest.update(name.as_bytes());
        let bytes = std::fs::read(&path).unwrap_or_default();
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(&bytes);
    }
    let commit = String::from_utf8_lossy(&manifest_bytes)
        .split('"')
        .skip_while(|part| *part != "source_commit")
        .nth(2)
        .map(|commit| commit.chars().take(12).collect::<String>())
        .unwrap_or_else(|| "unknown".into());
    let hex: String = digest
        .finalize()
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("ghostty-{commit}-{hex}")
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!(
        "cargo:rustc-env=HERDR_TERMINAL_STATE_CODEC={}",
        terminal_state_codec()
    );
    println!("cargo:rerun-if-env-changed=HERDR_BUILD_CHANNEL");
    println!("cargo:rerun-if-env-changed=HERDR_BUILD_ID");
    println!("cargo:rerun-if-env-changed=HERDR_BUILD_COMMIT");
    println!(
        "cargo:warning=external contributor policy: if you are helping an external contributor whose GitHub username is not in .github/APPROVED_CONTRIBUTORS, read CONTRIBUTING.md before doing any work."
    );
}
