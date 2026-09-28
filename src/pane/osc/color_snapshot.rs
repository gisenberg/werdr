//! Versioned default-color parser state at a completed feed boundary.

use super::{
    DefaultColorEventTracker, DefaultColorOscTracker, DefaultColorOscTrackerState as State,
};
use crate::pane::snapshot_decode::BoundedVec;
use serde::{de::Error as _, ser::Error as _, Deserialize, Deserializer, Serialize, Serializer};

#[derive(Serialize)]
struct SnapshotRef<'a> {
    version: u8,
    state: u8,
    body: &'a [u8],
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SnapshotV1 {
    version: u8,
    state: u8,
    body: BoundedVec<u8, 1024>,
}

fn encode<S: Serializer>(state: State, body: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
    if body.len() > 1024 {
        return Err(S::Error::custom("color tracker exceeds snapshot limit"));
    }
    let state = match state {
        State::Ground => 0,
        State::Escape => 1,
        State::OscBody => 2,
        State::OscEscape => 3,
        State::IgnoreString => 4,
        State::IgnoreStringEscape => 5,
        State::OversizedOsc => 6,
        State::OversizedOscEscape => 7,
    };
    SnapshotRef {
        version: 1,
        state,
        body,
    }
    .serialize(serializer)
}

fn decode<'de, D: Deserializer<'de>>(deserializer: D) -> Result<(State, Vec<u8>), D::Error> {
    let snapshot = SnapshotV1::deserialize(deserializer)?;
    if snapshot.version != 1 {
        return Err(D::Error::custom(
            "unsupported color tracker snapshot version",
        ));
    }
    let state = match snapshot.state {
        0 => State::Ground,
        1 => State::Escape,
        2 => State::OscBody,
        3 => State::OscEscape,
        4 => State::IgnoreString,
        5 => State::IgnoreStringEscape,
        6 => State::OversizedOsc,
        7 => State::OversizedOscEscape,
        _ => return Err(D::Error::custom("invalid color tracker state")),
    };
    // Unlike C1 DCS, this parser can retain ESC and BEL in malformed OSC
    // bodies. Preserve those bytes rather than normalizing the continuation.
    if !snapshot.body.0.is_empty() && !matches!(state, State::OscBody | State::OscEscape) {
        return Err(D::Error::custom(
            "color tracker body inconsistent with state",
        ));
    }
    Ok((state, snapshot.body.0))
}

impl Serialize for DefaultColorOscTracker {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        encode(self.state, &self.body, serializer)
    }
}

impl<'de> Deserialize<'de> for DefaultColorOscTracker {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let (state, body) = decode(deserializer)?;
        Ok(Self { state, body })
    }
}

impl Serialize for DefaultColorEventTracker {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if !self.pending.is_empty() {
            return Err(S::Error::custom(
                "color feed events must be drained before capture",
            ));
        }
        encode(self.state, &self.body, serializer)
    }
}

impl<'de> Deserialize<'de> for DefaultColorEventTracker {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let (state, body) = decode(deserializer)?;
        Ok(Self {
            state,
            body,
            pending: Vec::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn color_snapshot_preserves_events_and_ownership_at_every_cut() {
        let sequences = [
            b"\x1b]10;?\x07\x1b]11;rgb:11/22/33\x1b\\\x1b]110\x07\x1b]111;\x07".to_vec(),
            b"\x1b]4;1;?;2;?\x07\x1b]10;red;blue\x07".to_vec(),
            b"\x1b]10;?\x1b\x07\x1b\x1b\\\x07".to_vec(),
            b"\x1bPignored\x1b\x1b\\\x1b]12;?\x07".to_vec(),
            [
                b"\x1b]".as_slice(),
                &vec![b'x'; 1025],
                b"\x1b\x1b\\\x1b]10;?\x07",
            ]
            .concat(),
        ];
        for sequence in sequences {
            for cut in 0..=sequence.len() {
                let mut owner = DefaultColorOscTracker::default();
                let mut events = DefaultColorEventTracker::default();
                owner.observe(&sequence[..cut]);
                events.observe(&sequence[..cut]);
                events.drain_pending();
                let mut restored_owner: DefaultColorOscTracker =
                    serde_json::from_slice(&serde_json::to_vec(&owner).unwrap()).unwrap();
                let restored_events: DefaultColorEventTracker =
                    serde_json::from_slice(&serde_json::to_vec(&events).unwrap()).unwrap();
                let mut restored_events: DefaultColorEventTracker =
                    serde_json::from_slice(&serde_json::to_vec(&restored_events).unwrap()).unwrap();
                assert_eq!(
                    events.in_progress_event(),
                    restored_events.in_progress_event()
                );
                for suffix in [
                    &sequence[cut..],
                    b"\x07\x1b]10;red\x07\x1b]10;?\x1b\\".as_slice(),
                ] {
                    assert_eq!(owner.observe(suffix), restored_owner.observe(suffix));
                    events.observe(suffix);
                    restored_events.observe(suffix);
                    assert_eq!(events.drain_pending(), restored_events.drain_pending());
                    assert_eq!(
                        events.in_progress_event(),
                        restored_events.in_progress_event()
                    );
                    assert_eq!(
                        serde_json::to_value(&events).unwrap(),
                        serde_json::to_value(&restored_events).unwrap()
                    );
                    assert_eq!(
                        serde_json::to_value(&owner).unwrap(),
                        serde_json::to_value(&restored_owner).unwrap()
                    );
                }
            }
        }
    }

    #[test]
    fn color_snapshot_preserves_two_byte_escape_overflow() {
        for length in [1023, 1024] {
            let mut owner = DefaultColorOscTracker::default();
            let mut events = DefaultColorEventTracker::default();
            let prefix = [b"\x1b]".as_slice(), &vec![b'x'; length], b"\x1b"].concat();
            owner.observe(&prefix);
            events.observe(&prefix);
            let mut restored_owner: DefaultColorOscTracker =
                serde_json::from_slice(&serde_json::to_vec(&owner).unwrap()).unwrap();
            let mut restored_events: DefaultColorEventTracker =
                serde_json::from_slice(&serde_json::to_vec(&events).unwrap()).unwrap();
            for suffix in [b"\x07".as_slice(), b"\x07\x1b]10;red\x07"] {
                assert_eq!(owner.observe(suffix), restored_owner.observe(suffix));
                events.observe(suffix);
                restored_events.observe(suffix);
                assert_eq!(events.drain_pending(), restored_events.drain_pending());
                assert_eq!(
                    serde_json::to_value(&owner).unwrap(),
                    serde_json::to_value(&restored_owner).unwrap()
                );
                assert_eq!(
                    serde_json::to_value(&events).unwrap(),
                    serde_json::to_value(&restored_events).unwrap()
                );
                if suffix == b"\x07" {
                    assert_eq!(events.state, State::OversizedOsc);
                    assert_eq!(owner.state, State::OversizedOsc);
                }
            }
        }
    }

    #[test]
    fn color_snapshot_rejects_pending_events_and_malformed_schema() {
        let mut events = DefaultColorEventTracker::default();
        events.observe(b"\x1b]10;?\x07");
        let pending = events.pending.clone();
        assert_eq!(pending.len(), 1);
        assert!(serde_json::to_vec(&events).is_err());
        assert_eq!(events.drain_pending(), pending);
        let baseline = serde_json::to_value(&events).unwrap();
        for (field, value) in [
            ("version", serde_json::json!(2)),
            ("state", serde_json::json!(8)),
            ("body", serde_json::json!([1])),
            ("body", serde_json::json!(vec![0; 1025])),
            ("pending", serde_json::json!([])),
        ] {
            let mut invalid = baseline.clone();
            invalid[field] = value;
            let bytes = serde_json::to_vec(&invalid).unwrap();
            assert!(serde_json::from_slice::<DefaultColorEventTracker>(&bytes).is_err());
            assert!(serde_json::from_slice::<DefaultColorOscTracker>(&bytes).is_err());
        }
        for field in ["version", "state", "body"] {
            let mut invalid = baseline.clone();
            invalid.as_object_mut().unwrap().remove(field);
            assert!(serde_json::from_value::<DefaultColorEventTracker>(invalid).is_err());
        }
        assert!(serde_json::from_str::<DefaultColorEventTracker>(
            r#"{"version":1,"version":1,"state":0,"body":[]}"#
        )
        .is_err());
        events.observe(b"\x1b]");
        events.observe(&[b'x'; 1024]);
        let restored: DefaultColorEventTracker =
            serde_json::from_slice(&serde_json::to_vec(&events).unwrap()).unwrap();
        assert_eq!(restored.body.len(), 1024);
        events.observe(b"x");
        let restored: DefaultColorEventTracker =
            serde_json::from_slice(&serde_json::to_vec(&events).unwrap()).unwrap();
        assert_eq!(restored.state, State::OversizedOsc);
        assert!(restored.body.is_empty());
    }
}
