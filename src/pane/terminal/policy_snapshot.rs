//! Caller policy omitted from native terminal state. Restoring this DTO copies
//! policy only: it must not apply a theme, emit queries, or reset native colors.

use super::GhosttyPaneCore;
use crate::pane::snapshot_decode::BoundedVec;
use serde::{de::Error as _, Deserialize, Deserializer, Serialize, Serializer};

type Rgb = [u8; 3];
type Palette = [Option<Rgb>; 256];

fn serialize_palette<S: Serializer>(palette: &Palette, serializer: S) -> Result<S::Ok, S::Error> {
    palette.as_slice().serialize(serializer)
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub(super) struct PolicySnapshot {
    version: u8,
    synchronized_output_epoch: u64,
    initial_foreground: Option<Rgb>,
    initial_background: Option<Rgb>,
    host_foreground: Option<Rgb>,
    host_background: Option<Rgb>,
    #[serde(serialize_with = "serialize_palette")]
    palette: Palette,
    transient_owner_pgid: Option<u32>,
    child_foreground_changed: bool,
    child_background_changed: bool,
    windows_powershell_prompt_cwd_reporting: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PolicyV1 {
    version: u8,
    synchronized_output_epoch: u64,
    #[serde(deserialize_with = "Option::deserialize")]
    initial_foreground: Option<Rgb>,
    #[serde(deserialize_with = "Option::deserialize")]
    initial_background: Option<Rgb>,
    #[serde(deserialize_with = "Option::deserialize")]
    host_foreground: Option<Rgb>,
    #[serde(deserialize_with = "Option::deserialize")]
    host_background: Option<Rgb>,
    palette: BoundedVec<Option<Rgb>, 256>,
    #[serde(deserialize_with = "Option::deserialize")]
    transient_owner_pgid: Option<u32>,
    child_foreground_changed: bool,
    child_background_changed: bool,
    windows_powershell_prompt_cwd_reporting: bool,
}

impl<'de> Deserialize<'de> for PolicySnapshot {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let state = PolicyV1::deserialize(deserializer)?;
        if state.version != 1 || state.palette.0.len() != 256 {
            return Err(D::Error::custom("invalid terminal policy snapshot"));
        }
        Ok(Self {
            version: 1,
            synchronized_output_epoch: state.synchronized_output_epoch,
            initial_foreground: state.initial_foreground,
            initial_background: state.initial_background,
            host_foreground: state.host_foreground,
            host_background: state.host_background,
            palette: state
                .palette
                .0
                .try_into()
                .map_err(|_| D::Error::custom("invalid palette length"))?,
            transient_owner_pgid: state.transient_owner_pgid,
            child_foreground_changed: state.child_foreground_changed,
            child_background_changed: state.child_background_changed,
            windows_powershell_prompt_cwd_reporting: state.windows_powershell_prompt_cwd_reporting,
        })
    }
}

fn native(color: Rgb) -> crate::ghostty::RgbColor {
    crate::ghostty::RgbColor {
        r: color[0],
        g: color[1],
        b: color[2],
    }
}

fn host(color: Rgb) -> crate::terminal_theme::RgbColor {
    crate::terminal_theme::RgbColor {
        r: color[0],
        g: color[1],
        b: color[2],
    }
}

// The coordinated caller-state envelope will invoke these opt-in methods.
// Do not activate partial policy restoration in the legacy handoff path.
#[allow(dead_code)]
impl PolicySnapshot {
    pub(super) fn capture(core: &GhosttyPaneCore) -> Self {
        let theme = core.host_terminal_theme;
        Self {
            version: 1,
            synchronized_output_epoch: core.synchronized_output_epoch,
            initial_foreground: core.initial_default_foreground.map(|c| [c.r, c.g, c.b]),
            initial_background: core.initial_default_background.map(|c| [c.r, c.g, c.b]),
            host_foreground: theme.foreground.map(|c| [c.r, c.g, c.b]),
            host_background: theme.background.map(|c| [c.r, c.g, c.b]),
            palette: theme.palette.map(|c| c.map(|c| [c.r, c.g, c.b])),
            transient_owner_pgid: core.transient_default_color_owner_pgid,
            child_foreground_changed: core.child_default_foreground_changed,
            child_background_changed: core.child_default_background_changed,
            windows_powershell_prompt_cwd_reporting: core.windows_powershell_prompt_cwd_reporting,
        }
    }

    /// Apply only to an unpublished core restored from the matching native cut.
    /// Construction/deserialization ensures the exact palette length already.
    pub(super) fn apply(self, core: &mut GhosttyPaneCore) {
        core.synchronized_output_epoch = self.synchronized_output_epoch;
        core.initial_default_foreground = self.initial_foreground.map(native);
        core.initial_default_background = self.initial_background.map(native);
        core.host_terminal_theme = crate::terminal_theme::TerminalTheme {
            foreground: self.host_foreground.map(host),
            background: self.host_background.map(host),
            palette: std::array::from_fn(|i| self.palette[i].map(host)),
        };
        core.transient_default_color_owner_pgid = self.transient_owner_pgid;
        core.child_default_foreground_changed = self.child_foreground_changed;
        core.child_default_background_changed = self.child_background_changed;
        core.windows_powershell_prompt_cwd_reporting = self.windows_powershell_prompt_cwd_reporting;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pane::terminal::GhosttyPaneTerminal;
    use tokio::sync::mpsc;

    fn pane() -> GhosttyPaneTerminal {
        let (tx, _rx) = mpsc::channel(4);
        GhosttyPaneTerminal::new(
            crate::ghostty::Terminal::new_with_snapshot_tracking(40, 5, 1024, 4096).unwrap(),
            tx,
        )
        .unwrap()
    }

    #[test]
    fn policy_snapshot_preserves_all_policy_without_native_side_effects() {
        let source = pane();
        let restored = pane();
        for flags in 0..8 {
            let mut core = source.core.lock().unwrap();
            core.synchronized_output_epoch = u64::MAX;
            core.initial_default_foreground = Some(native([1, 2, 3]));
            core.initial_default_background = None;
            core.host_terminal_theme.foreground = None;
            core.host_terminal_theme.background = Some(host([4, 5, 6]));
            core.host_terminal_theme.palette = std::array::from_fn(|i| {
                if i % 2 == 0 {
                    Some(host([i as u8, 255, 0]))
                } else {
                    None
                }
            });
            core.transient_default_color_owner_pgid = Some(u32::MAX);
            core.child_default_foreground_changed = flags & 1 != 0;
            core.child_default_background_changed = flags & 2 != 0;
            core.windows_powershell_prompt_cwd_reporting = flags & 4 != 0;
            let captured = PolicySnapshot::capture(&core);
            let bytes = serde_json::to_vec(&captured).unwrap();
            assert_eq!(PolicySnapshot::capture(&core), captured);
            let decoded: PolicySnapshot = serde_json::from_slice(&bytes).unwrap();
            let mut target = restored.core.lock().unwrap();
            let native_before = target.terminal.snapshot_bytes().unwrap();
            let callbacks_before = target.terminal.callback_snapshot(4096).unwrap();
            decoded.apply(&mut target);
            assert_eq!(PolicySnapshot::capture(&target), captured);
            assert_eq!(target.terminal.snapshot_bytes().unwrap(), native_before);
            assert_eq!(
                target.terminal.callback_snapshot(4096).unwrap(),
                callbacks_before
            );
        }
    }

    #[test]
    fn policy_snapshot_rejects_missing_fields_bad_colors_and_palette_lengths() {
        let source = pane();
        let baseline =
            serde_json::to_value(PolicySnapshot::capture(&source.core.lock().unwrap())).unwrap();
        for field in baseline.as_object().unwrap().keys() {
            let mut invalid = baseline.clone();
            invalid.as_object_mut().unwrap().remove(field);
            assert!(
                serde_json::from_value::<PolicySnapshot>(invalid).is_err(),
                "{field}"
            );
        }
        for (field, value) in [
            ("version", serde_json::json!(2)),
            ("unknown", serde_json::json!(null)),
            ("initial_foreground", serde_json::json!([1, 2])),
            ("initial_background", serde_json::json!([1, 2, 3, 4])),
            ("host_foreground", serde_json::json!([0, 256, 0])),
            ("transient_owner_pgid", serde_json::json!(4294967296_u64)),
        ] {
            let mut invalid = baseline.clone();
            invalid[field] = value;
            assert!(serde_json::from_value::<PolicySnapshot>(invalid).is_err());
        }
        for count in [0, 255, 257] {
            let mut invalid = baseline.clone();
            invalid["palette"] = serde_json::json!(vec![Option::<Rgb>::None; count]);
            assert!(serde_json::from_slice::<PolicySnapshot>(
                &serde_json::to_vec(&invalid).unwrap()
            )
            .is_err());
        }
        let valid = serde_json::to_string(&baseline).unwrap();
        assert!(
            serde_json::from_str::<PolicySnapshot>(&valid.replacen('{', "{\"version\":1,", 1))
                .is_err()
        );
    }

    #[test]
    fn policy_snapshot_continues_color_ownership_resets_and_epoch_wrap() {
        use crate::{layout::PaneId, terminal_theme::TerminalTheme};
        for foreground_owned in [false, true] {
            for background_owned in [false, true] {
                let (tx, _rx) = mpsc::channel(16);
                let source = pane();
                let feed = |pane: &GhosttyPaneTerminal, input: &[u8]| {
                    pane.process_pty_bytes(PaneId::from_raw(1), 0, input, &tx)
                        .terminal_responses
                };
                source.apply_host_terminal_theme(TerminalTheme {
                    foreground: Some(host([1, 2, 3])),
                    background: Some(host([4, 5, 6])),
                    ..TerminalTheme::default()
                });
                if foreground_owned {
                    feed(&source, b"\x1b]10;#112233\x07");
                }
                if background_owned {
                    feed(&source, b"\x1b]11;#445566\x07");
                }
                let core = source.core.lock().unwrap();
                let state = serde_json::to_vec(&PolicySnapshot::capture(&core)).unwrap();
                let native = core.terminal.snapshot_bytes().unwrap();
                let callbacks = core.terminal.callback_snapshot(4096).unwrap();
                drop(core);
                let mut terminal = crate::ghostty::Terminal::from_snapshot(&native, 4096).unwrap();
                terminal.restore_callback_snapshot(callbacks, 4096).unwrap();
                let restored = GhosttyPaneTerminal::new(terminal, tx.clone()).unwrap();
                serde_json::from_slice::<PolicySnapshot>(&state)
                    .unwrap()
                    .apply(&mut restored.core.lock().unwrap());
                for pane in [&source, &restored] {
                    pane.apply_host_terminal_theme(TerminalTheme {
                        foreground: Some(host([0xaa, 0xbb, 0xcc])),
                        background: Some(host([0xdd, 0xee, 0xff])),
                        ..TerminalTheme::default()
                    });
                }
                let query = b"\x1b]10;?\x07\x1b]11;?\x07";
                let replies = feed(&source, query);
                assert_eq!(replies, feed(&restored, query));
                assert_eq!(replies.len(), 2);
                let foreground: &[u8] = if foreground_owned {
                    b"\x1b]10;rgb:1111/2222/3333\x07"
                } else {
                    b"\x1b]10;rgb:aaaa/bbbb/cccc\x1b\\"
                };
                let background: &[u8] = if background_owned {
                    b"\x1b]11;rgb:4444/5555/6666\x07"
                } else {
                    b"\x1b]11;rgb:dddd/eeee/ffff\x1b\\"
                };
                assert_eq!(replies[0].as_ref(), foreground);
                assert_eq!(replies[1].as_ref(), background);
                for pane in [&source, &restored] {
                    feed(pane, b"\x1b]110\x07\x1b]111\x07");
                }
                let replies = feed(&source, query);
                assert_eq!(replies, feed(&restored, query));
                assert_eq!(replies[0].as_ref(), b"\x1b]10;rgb:aaaa/bbbb/cccc\x1b\\");
                assert_eq!(replies[1].as_ref(), b"\x1b]11;rgb:dddd/eeee/ffff\x1b\\");
                for pane in [&source, &restored] {
                    pane.core.lock().unwrap().synchronized_output_epoch = u64::MAX;
                    feed(pane, b"\x1b[?2026hheld");
                    assert_eq!(pane.core.lock().unwrap().synchronized_output_epoch, 0);
                    feed(pane, b"\x1b[?2026l");
                    assert_eq!(pane.core.lock().unwrap().synchronized_output_epoch, 1);
                }
                assert_eq!(
                    PolicySnapshot::capture(&source.core.lock().unwrap()),
                    PolicySnapshot::capture(&restored.core.lock().unwrap())
                );
            }
        }
    }

    #[test]
    fn policy_snapshot_preserves_default_color_classification_and_owner_transition() {
        use crate::{
            layout::PaneId,
            platform::{ForegroundJob, ForegroundProcess},
        };
        let source = pane();
        let restored = pane();
        let mut source = source.core.lock().unwrap();
        source.initial_default_foreground = Some(native([1, 2, 3]));
        source.initial_default_background = Some(native([4, 5, 6]));
        source.transient_default_color_owner_pgid = Some(42);
        let bytes = serde_json::to_vec(&PolicySnapshot::capture(&source)).unwrap();
        let mut restored = restored.core.lock().unwrap();
        serde_json::from_slice::<PolicySnapshot>(&bytes)
            .unwrap()
            .apply(&mut restored);
        for core in [&*source, &*restored] {
            assert_eq!(
                super::super::ghostty_default_fg(
                    native([1, 2, 3]),
                    core.host_terminal_theme,
                    core.initial_default_foreground
                ),
                None
            );
            assert_eq!(
                super::super::ghostty_default_fg(
                    native([7, 8, 9]),
                    core.host_terminal_theme,
                    core.initial_default_foreground
                ),
                Some(ratatui::style::Color::Rgb(7, 8, 9))
            );
            assert_eq!(
                super::super::ghostty_default_bg(
                    native([4, 5, 6]),
                    core.host_terminal_theme,
                    core.initial_default_background
                ),
                None
            );
            assert_eq!(
                super::super::ghostty_default_bg(
                    native([7, 8, 9]),
                    core.host_terminal_theme,
                    core.initial_default_background
                ),
                Some(ratatui::style::Color::Rgb(7, 8, 9))
            );
        }
        let shell = ForegroundJob {
            process_group_id: 7,
            processes: vec![ForegroundProcess {
                pid: 7,
                name: "shell".into(),
                argv0: None,
                argv: None,
                cmdline: None,
            }],
        };
        for core in [&mut *source, &mut *restored] {
            assert!(!super::super::restore_host_terminal_theme_if_needed(
                core,
                PaneId::from_raw(1),
                7,
                false,
                Some(&shell)
            ));
            assert_eq!(core.transient_default_color_owner_pgid, Some(42));
        }
        source.host_terminal_theme.foreground = Some(host([10, 20, 30]));
        let bytes = serde_json::to_vec(&PolicySnapshot::capture(&source)).unwrap();
        serde_json::from_slice::<PolicySnapshot>(&bytes)
            .unwrap()
            .apply(&mut restored);
        for core in [&mut *source, &mut *restored] {
            assert!(!super::super::restore_host_terminal_theme_if_needed(
                core,
                PaneId::from_raw(1),
                7,
                true,
                Some(&shell)
            ));
            assert_eq!(core.transient_default_color_owner_pgid, Some(42));
            assert!(super::super::restore_host_terminal_theme_if_needed(
                core,
                PaneId::from_raw(1),
                7,
                false,
                Some(&shell)
            ));
            assert_eq!(core.transient_default_color_owner_pgid, None);
        }
        assert_eq!(
            PolicySnapshot::capture(&source),
            PolicySnapshot::capture(&restored)
        );
    }
}
