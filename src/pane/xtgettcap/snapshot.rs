//! Versioned continuation at a completed feed boundary. Pending responses use
//! offsets into the current feed and must be drained before capture.

use super::{C1XtgettcapQueryTracker, C1XtgettcapTrackerState as State};
use crate::pane::snapshot_decode::BoundedVec;
use serde::{de::Error as _, ser::Error as _, Deserialize, Deserializer, Serialize, Serializer};

// Explicit tags keep the codec independent of the runtime enum's layout.
fn state_tag(state: State) -> u8 {
    match state {
        State::Ground => 0,
        State::Escape => 1,
        State::DcsIntro => 2,
        State::DcsIntroPlus => 3,
        State::DcsBody => 4,
        State::DcsEscape => 5,
        State::IgnoreOsc => 6,
        State::IgnoreOscEscape => 7,
        State::IgnoreString => 8,
        State::IgnoreStringEscape => 9,
        State::OversizedDcs => 10,
        State::OversizedDcsEscape => 11,
    }
}

fn state_from_tag(tag: u8) -> Option<State> {
    Some(match tag {
        0 => State::Ground,
        1 => State::Escape,
        2 => State::DcsIntro,
        3 => State::DcsIntroPlus,
        4 => State::DcsBody,
        5 => State::DcsEscape,
        6 => State::IgnoreOsc,
        7 => State::IgnoreOscEscape,
        8 => State::IgnoreString,
        9 => State::IgnoreStringEscape,
        10 => State::OversizedDcs,
        11 => State::OversizedDcsEscape,
        _ => return None,
    })
}

#[derive(Serialize)]
struct SnapshotRef<'a> {
    version: u8,
    state: u8,
    raw_c1_intro: bool,
    native_dcs_pending: bool,
    body: &'a [u8],
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SnapshotV1 {
    version: u8,
    state: u8,
    raw_c1_intro: bool,
    native_dcs_pending: bool,
    body: BoundedVec<u8, 1024>,
}

impl Serialize for C1XtgettcapQueryTracker {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if !self.pending.is_empty() {
            return Err(S::Error::custom(
                "XTGETTCAP feed responses must be drained before capture",
            ));
        }
        if self.body.len() > 1024 {
            return Err(S::Error::custom("XTGETTCAP body exceeds snapshot limit"));
        }
        SnapshotRef {
            version: 1,
            state: state_tag(self.state),
            raw_c1_intro: self.raw_c1_intro,
            native_dcs_pending: self.native_dcs_pending,
            body: &self.body,
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for C1XtgettcapQueryTracker {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let snapshot = SnapshotV1::deserialize(deserializer)?;
        if snapshot.version != 1 {
            return Err(D::Error::custom("unsupported XTGETTCAP snapshot version"));
        }
        let state = state_from_tag(snapshot.state)
            .ok_or_else(|| D::Error::custom("invalid XTGETTCAP state"))?;
        if snapshot
            .body
            .0
            .iter()
            .any(|byte| matches!(byte, 0x1b | 0x9c))
        {
            return Err(D::Error::custom(
                "XTGETTCAP body contains a framing delimiter",
            ));
        }
        if !snapshot.body.0.is_empty() && !matches!(state, State::DcsBody | State::DcsEscape) {
            return Err(D::Error::custom(
                "XTGETTCAP body inconsistent with parser state",
            ));
        }
        Ok(Self {
            state,
            raw_c1_intro: snapshot.raw_c1_intro,
            native_dcs_pending: snapshot.native_dcs_pending,
            body: snapshot.body.0,
            pending: Vec::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn c1_snapshot_preserves_replies_and_suppression_at_every_cut() {
        let sequences = [
            b"\x90+q524742;4D73\x9c".to_vec(),
            b"\x1bP+q524742;4D73\x9c\x1b\\\x1bP+q524742\x1b\\".to_vec(),
            b"\x1bP+q524742\x9c\x18\x90+q4D73\x1b\\".to_vec(),
            b"\x1bP+q524742\x9c\x1a\x90+q4D73\x1b\x1b\\".to_vec(),
            b"\x9dignored\x1b\x1b\\\x98ignored\x1b\\\x90+q524742\x9c".to_vec(),
            [
                b"\x90+q".as_slice(),
                &vec![b'a'; 1025],
                b"\x1b\\\x90+q524742\x9c",
            ]
            .concat(),
        ];
        for sequence in sequences {
            for cut in 0..=sequence.len() {
                let mut original = C1XtgettcapQueryTracker::default();
                original.observe(&sequence[..cut]);
                original.drain_pending();
                let bytes = serde_json::to_vec(&original).unwrap();
                let restored: C1XtgettcapQueryTracker = serde_json::from_slice(&bytes).unwrap();
                let mut restored: C1XtgettcapQueryTracker =
                    serde_json::from_slice(&serde_json::to_vec(&restored).unwrap()).unwrap();
                for suffix in [&sequence[cut..], b"\x1b\\\x90+q4D73\x9c".as_slice()] {
                    original.observe(suffix);
                    restored.observe(suffix);
                    assert_eq!(
                        original.drain_pending(),
                        restored.drain_pending(),
                        "cut={cut}"
                    );
                    assert_eq!(
                        serde_json::to_value(&original).unwrap(),
                        serde_json::to_value(&restored).unwrap()
                    );
                }
            }
        }
    }

    #[test]
    fn c1_snapshot_validates_exact_body_bound_and_schema() {
        let mut tracker = C1XtgettcapQueryTracker::default();
        tracker.observe(b"\x90+q");
        tracker.observe(&[b'a'; 1024]);
        let baseline = serde_json::to_value(&tracker).unwrap();
        let restored: C1XtgettcapQueryTracker =
            serde_json::from_slice(&serde_json::to_vec(&tracker).unwrap()).unwrap();
        assert_eq!(restored.body.len(), 1024);
        for body in [vec![b'a'; 1025], vec![0x1b], vec![0x9c]] {
            let mut invalid = baseline.clone();
            invalid["body"] = serde_json::json!(body);
            assert!(serde_json::from_slice::<C1XtgettcapQueryTracker>(
                &serde_json::to_vec(&invalid).unwrap()
            )
            .is_err());
        }
        for field in [
            "version",
            "state",
            "raw_c1_intro",
            "native_dcs_pending",
            "body",
        ] {
            let mut invalid = baseline.clone();
            invalid.as_object_mut().unwrap().remove(field);
            assert!(serde_json::from_value::<C1XtgettcapQueryTracker>(invalid).is_err());
        }
        assert!(serde_json::from_str::<C1XtgettcapQueryTracker>(r#"{"version":1,"version":1,"state":0,"raw_c1_intro":false,"native_dcs_pending":false,"body":[]}"#).is_err());
        tracker.observe(b"a");
        assert_eq!(tracker.state, State::OversizedDcs);
        assert!(tracker.body.is_empty());
        let restored: C1XtgettcapQueryTracker =
            serde_json::from_slice(&serde_json::to_vec(&tracker).unwrap()).unwrap();
        assert_eq!(restored.state, State::OversizedDcs);
    }

    #[test]
    fn c1_snapshot_rejects_undrained_responses_and_invalid_state() {
        let mut tracker = C1XtgettcapQueryTracker::default();
        tracker.observe(b"\x1bP+q524742\x9c");
        let pending = tracker.pending.clone();
        assert!(!pending.is_empty());
        assert!(serde_json::to_vec(&tracker).is_err());
        assert_eq!(tracker.drain_pending(), pending);
        let mut restored: C1XtgettcapQueryTracker =
            serde_json::from_slice(&serde_json::to_vec(&tracker).unwrap()).unwrap();
        restored.observe(b"\x1b");
        let replies = restored.drain_pending();
        assert_eq!(replies.len(), 1);
        assert!(replies[0].suppress_native);
        let baseline = serde_json::to_value(C1XtgettcapQueryTracker::default()).unwrap();
        for (field, value) in [
            ("version", serde_json::json!(2)),
            ("state", serde_json::json!(12)),
            ("body", serde_json::json!([1])),
            ("body", serde_json::json!(vec![0; 1025])),
            ("pending", serde_json::json!([])),
        ] {
            let mut invalid = baseline.clone();
            invalid[field] = value;
            assert!(serde_json::from_slice::<C1XtgettcapQueryTracker>(
                &serde_json::to_vec(&invalid).unwrap()
            )
            .is_err());
        }
    }
}
