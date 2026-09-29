//! Construction policy shared by fresh and legacy-imported runtimes.

// Retained unfinished input, not history or a snapshot allocation budget.
// The native tracker starts at 4 KiB and grows only for unfinished sequences.
// Overlong input keeps parsing normally but makes capture unavailable until
// a genuine parser recovery. Never truncate or substitute ANSI for that state.
const CONTINUATION_BYTES: usize = 1 << 20;

pub(super) fn new(
    cols: u16,
    rows: u16,
    scrollback_bytes: usize,
) -> Result<crate::ghostty::Terminal, crate::ghostty::Error> {
    crate::ghostty::Terminal::new_with_snapshot_tracking(
        cols,
        rows,
        scrollback_bytes,
        CONTINUATION_BYTES,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_tracking_overflow_rejects_capture_not_input() {
        let mut source = new(40, 5, 100_000).unwrap();
        source.write(b"\x1b]2;");
        source.write(&vec![b'a'; CONTINUATION_BYTES + 1]);
        assert!(source.snapshot_bytes().is_err());
        source.write(b"\x07recovered");
        let restored = crate::ghostty::Terminal::from_snapshot(
            &source.snapshot_bytes().unwrap(),
            CONTINUATION_BYTES,
        )
        .unwrap();
        let visible = source
            .screen_vt(crate::ghostty::ActiveScreen::Primary)
            .unwrap();
        assert!(visible.contains("recovered"));
        assert_eq!(
            visible,
            restored
                .screen_vt(crate::ghostty::ActiveScreen::Primary)
                .unwrap()
        );
    }

    // Same process, geometry, history and byte stream. Alternating order limits
    // warm-cache bias; timings are supporting evidence, not a CI assertion.
    #[test]
    #[ignore = "non-gating output parsing scaling profile"]
    fn runtime_tracking_parse_profile() {
        use std::{hint::black_box, time::Instant};
        let workloads: &[(&str, &[&[u8]])] = &[
            (
                "ground",
                &[b"plain output 0123456789\r\n\x1b[31mcolored\x1b[0m\r\n"],
            ),
            (
                "split",
                &[
                    b"text\x1b[38;2;10;",
                    b"20;30m\xf0\x9f",
                    b"\x98\x80\x1b]2;ti",
                    b"tle\x07\r\n",
                ],
            ),
        ];
        for panes in [1, 15] {
            for (name, chunks) in workloads {
                for tracked in [false, true, true, false] {
                    let mut terminals: Vec<_> = (0..panes)
                        .map(|_| {
                            if tracked {
                                new(120, 40, 1_000_000)
                            } else {
                                crate::ghostty::Terminal::new(120, 40, 1_000_000)
                            }
                            .unwrap()
                        })
                        .collect();
                    for terminal in &mut terminals {
                        for _ in 0..1000 {
                            terminal.write(b"populated history\r\n");
                        }
                    }
                    let start = Instant::now();
                    for _ in 0..1_000_000 {
                        for terminal in &mut terminals {
                            for chunk in *chunks {
                                terminal.write(black_box(chunk));
                            }
                        }
                    }
                    eprintln!("tracking_parse panes={panes} workload={name} tracked={tracked} elapsed_us={}", start.elapsed().as_micros());
                    black_box(terminals);
                }
            }
        }
    }
}
