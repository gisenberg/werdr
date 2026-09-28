//! Explicit versioned tracker state, independent of native core snapshots.
//! Runtime capture must serialize this at the same exclusive input cut.

use super::KittyKeyboardTracker;
use crate::pane::snapshot_decode::BoundedVec;
use serde::{de::Error as _, ser::Error as _, Deserialize, Deserializer, Serialize, Serializer};

// This bounds snapshot transport, not live tracking. Export must reject a
// deeper stack without mutating or truncating the original tracker.
const MAX_STACK_ENTRIES: usize = 4096;
const MAX_PENDING_BYTES: usize = 64;

#[derive(Serialize)]
struct SnapshotRef<'a> {
    version: u8,
    pending: &'a [u8],
    stack: &'a [u16],
    flags: u16,
    modify_other_keys_level: u8,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SnapshotV1 {
    version: u8,
    pending: BoundedVec<u8, MAX_PENDING_BYTES>,
    stack: BoundedVec<u16, MAX_STACK_ENTRIES>,
    flags: u16,
    modify_other_keys_level: u8,
}

fn valid_pending(bytes: &[u8]) -> bool {
    bytes.is_empty()
        || bytes == b"\x1b"
        || bytes
            .strip_prefix(b"\x1b[")
            .is_some_and(|body| body.iter().all(|byte| !(0x40..=0x7e).contains(byte)))
}

impl Serialize for KittyKeyboardTracker {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if self.stack.len() > MAX_STACK_ENTRIES || self.pending.len() > MAX_PENDING_BYTES {
            return Err(S::Error::custom("keyboard tracker exceeds snapshot limit"));
        }
        SnapshotRef {
            version: 1,
            pending: &self.pending,
            stack: &self.stack,
            flags: self.flags,
            modify_other_keys_level: self.modify_other_keys_level,
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for KittyKeyboardTracker {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let snapshot = SnapshotV1::deserialize(deserializer)?;
        if snapshot.version != 1
            || snapshot.modify_other_keys_level > 2
            || !valid_pending(&snapshot.pending.0)
        {
            return Err(D::Error::custom("invalid keyboard tracker snapshot"));
        }
        Ok(Self {
            pending: snapshot.pending.0,
            stack: snapshot.stack.0,
            flags: snapshot.flags,
            modify_other_keys_level: snapshot.modify_other_keys_level,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyboard_snapshot_preserves_future_behavior_at_every_cut() {
        for sequence in [
            b"\x1b[>9u\x1b[>4;2m\x1b[<u".as_slice(),
            b"\x1b[>5u\x1b[=7u\x1b[<2u",
            b"\x1bc\x1b[>4;1m",
            b"\x1b[>04n",
        ] {
            for cut in 0..=sequence.len() {
                let mut original = KittyKeyboardTracker::default();
                original.observe(b"\x1b[>1u\x1b[>3u");
                original.observe(&sequence[..cut]);
                let bytes = serde_json::to_vec(&original).unwrap();
                let restored: KittyKeyboardTracker = serde_json::from_slice(&bytes).unwrap();
                let mut restored: KittyKeyboardTracker =
                    serde_json::from_slice(&serde_json::to_vec(&restored).unwrap()).unwrap();
                for suffix in [
                    &sequence[cut..],
                    b"\x1b[<u".as_slice(),
                    b"\x1b[<u\x1b[>4n".as_slice(),
                ] {
                    original.observe(suffix);
                    restored.observe(suffix);
                    assert_eq!(
                        serde_json::to_value(&original).unwrap(),
                        serde_json::to_value(&restored).unwrap()
                    );
                }
            }
        }
    }

    #[test]
    fn keyboard_snapshot_rejects_invalid_and_oversized_state_without_truncation() {
        let mut original = KittyKeyboardTracker::default();
        let baseline = serde_json::to_value(&original).unwrap();
        for (field, value) in [
            ("version", serde_json::json!(2)),
            ("modify_other_keys_level", serde_json::json!(3)),
            ("pending", serde_json::json!([27, 91, 117])),
            ("pending", serde_json::json!(vec![27; 65])),
            ("stack", serde_json::json!(vec![0; MAX_STACK_ENTRIES + 1])),
            ("unknown", serde_json::json!(true)),
        ] {
            let mut invalid = baseline.clone();
            invalid[field] = value;
            assert!(serde_json::from_slice::<KittyKeyboardTracker>(
                &serde_json::to_vec(&invalid).unwrap()
            )
            .is_err());
            assert!(
                serde_json::from_value::<KittyKeyboardTracker>(invalid).is_err(),
                "field {field}"
            );
        }
        for _ in 0..=MAX_STACK_ENTRIES {
            original.observe(b"\x1b[>3u");
        }
        assert!(serde_json::to_vec(&original).is_err());
        assert_eq!(original.stack.len(), MAX_STACK_ENTRIES + 1);
        original.observe(b"\x1b[<u");
        let decoded: KittyKeyboardTracker =
            serde_json::from_slice(&serde_json::to_vec(&original).unwrap()).unwrap();
        assert_eq!(decoded.stack, original.stack);
    }

    #[test]
    fn keyboard_snapshot_accepts_reachable_pending_and_rejects_ambiguous_fields() {
        for pending in [
            [b"\x1b[".as_slice(), &[b'1'; 62]].concat(),
            b"\x1b[\x1b\x00".to_vec(),
        ] {
            let mut original = KittyKeyboardTracker::default();
            original.observe(&pending);
            assert_eq!(original.pending, pending);
            let mut restored: KittyKeyboardTracker =
                serde_json::from_slice(&serde_json::to_vec(&original).unwrap()).unwrap();
            for suffix in [b"u".as_slice(), b"\x1b[>7u", b"\x1b[<u"] {
                original.observe(suffix);
                restored.observe(suffix);
                assert_eq!(
                    serde_json::to_value(&original).unwrap(),
                    serde_json::to_value(&restored).unwrap()
                );
            }
        }
        let baseline = serde_json::to_value(KittyKeyboardTracker::default()).unwrap();
        for field in [
            "version",
            "pending",
            "stack",
            "flags",
            "modify_other_keys_level",
        ] {
            let mut invalid = baseline.clone();
            invalid.as_object_mut().unwrap().remove(field);
            assert!(serde_json::from_value::<KittyKeyboardTracker>(invalid).is_err());
        }
        assert!(serde_json::from_str::<KittyKeyboardTracker>(r#"{"version":1,"version":1,"pending":[],"stack":[],"flags":0,"modify_other_keys_level":0}"#).is_err());
    }
}
