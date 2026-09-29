//! Presentation timers resume with the remaining hold duration at capture.
//! Never serialize process-local Instant values. Ages beyond the maximum hold
//! are equivalent expired states, so retain them as the maximum age.

use super::{CursorPositionSettleState, TerminalCursorState, CURSOR_POSITION_MAX_HOLD};
use serde::{de::Error as _, ser::Error as _, Deserialize, Deserializer, Serialize, Serializer};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CursorV1 {
    x: u16,
    y: u16,
    visible: bool,
    shape: u8,
}

impl From<TerminalCursorState> for CursorV1 {
    fn from(cursor: TerminalCursorState) -> Self {
        Self {
            x: cursor.x,
            y: cursor.y,
            visible: cursor.visible,
            shape: cursor.shape,
        }
    }
}
impl From<CursorV1> for TerminalCursorState {
    fn from(cursor: CursorV1) -> Self {
        Self {
            x: cursor.x,
            y: cursor.y,
            visible: cursor.visible,
            shape: cursor.shape,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SnapshotV1 {
    version: u8,
    #[serde(deserialize_with = "Option::deserialize")]
    settled: Option<CursorV1>,
    #[serde(deserialize_with = "Option::deserialize")]
    candidate: Option<CursorV1>,
    #[serde(deserialize_with = "Option::deserialize")]
    pending_age_ns: Option<u64>,
    #[serde(deserialize_with = "Option::deserialize")]
    candidate_age_ns: Option<u64>,
    candidate_jump: bool,
}

fn age(now: Instant, since: Option<Instant>) -> Result<Option<u64>, &'static str> {
    since
        .map(|since| {
            now.checked_duration_since(since)
                .map(|age| age.min(CURSOR_POSITION_MAX_HOLD).as_nanos() as u64)
                .ok_or("cursor timer is after capture time")
        })
        .transpose()
}

impl SnapshotV1 {
    pub(crate) fn capture(
        state: &CursorPositionSettleState,
        now: Instant,
    ) -> Result<Self, &'static str> {
        Ok(Self {
            version: 1,
            settled: state.settled.map(Into::into),
            candidate: state.candidate.map(Into::into),
            pending_age_ns: age(now, state.pending_since)?,
            candidate_age_ns: age(now, state.candidate_since)?,
            candidate_jump: state.candidate_jump,
        })
    }

    pub(crate) fn restore(self, now: Instant) -> Result<CursorPositionSettleState, &'static str> {
        let max_age = CURSOR_POSITION_MAX_HOLD.as_nanos() as u64;
        if self.version != 1
            || self
                .settled
                .into_iter()
                .chain(self.candidate)
                .any(|cursor| cursor.shape > 6)
            || self
                .pending_age_ns
                .into_iter()
                .chain(self.candidate_age_ns)
                .any(|age| age > max_age)
            || self.candidate.is_some() != self.pending_age_ns.is_some()
            || self.candidate.is_some() != self.candidate_age_ns.is_some()
            || (self.candidate.is_some() && self.settled.is_none())
            || (self.candidate.is_none() && self.candidate_jump)
            || self
                .pending_age_ns
                .zip(self.candidate_age_ns)
                .is_some_and(|(pending, candidate)| pending < candidate)
        {
            return Err("invalid cursor settle snapshot");
        }
        let restore_time = |age: Option<u64>| {
            age.map(|age| {
                now.checked_sub(Duration::from_nanos(age))
                    .ok_or("cursor timer clock underflow")
            })
            .transpose()
        };
        Ok(CursorPositionSettleState {
            settled: self.settled.map(Into::into),
            candidate: self.candidate.map(Into::into),
            pending_since: restore_time(self.pending_age_ns)?,
            candidate_since: restore_time(self.candidate_age_ns)?,
            candidate_jump: self.candidate_jump,
        })
    }
}

impl Serialize for CursorPositionSettleState {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        SnapshotV1::capture(self, Instant::now())
            .map_err(S::Error::custom)?
            .serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for CursorPositionSettleState {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        SnapshotV1::deserialize(deserializer)?
            .restore(Instant::now())
            .map_err(D::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_settle_snapshot_preserves_future_timing_after_clock_rebase() {
        let start = Instant::now();
        let baseline = TerminalCursorState {
            x: 2,
            y: 3,
            visible: true,
            shape: 1,
        };
        for candidate in [
            TerminalCursorState { x: 3, ..baseline },
            TerminalCursorState { y: 8, ..baseline },
            TerminalCursorState {
                visible: false,
                ..baseline
            },
        ] {
            for age_ns in [
                0,
                19_999_999,
                20_000_000,
                99_999_999,
                100_000_000,
                500_000_000,
            ] {
                let mut source = CursorPositionSettleState::default();
                source.observe(Some(baseline), start);
                source.observe(Some(candidate), start + Duration::from_millis(1));
                let cut = start + Duration::from_millis(1) + Duration::from_nanos(age_ns);
                let target_cut = cut + Duration::from_secs(10);
                let bytes =
                    serde_json::to_vec(&SnapshotV1::capture(&source, cut).unwrap()).unwrap();
                let restored = serde_json::from_slice::<SnapshotV1>(&bytes)
                    .unwrap()
                    .restore(target_cut)
                    .unwrap();
                let mut restored = SnapshotV1::capture(&restored, target_cut)
                    .unwrap()
                    .restore(target_cut)
                    .unwrap();
                for elapsed in [0, 1, 20_000_000, 100_000_000] {
                    let delta = Duration::from_nanos(elapsed);
                    assert_eq!(
                        source.reported_cursor(Some(candidate), cut + delta),
                        restored.reported_cursor(Some(candidate), target_cut + delta)
                    );
                    assert_eq!(source.render_delay(), restored.render_delay());
                }
                source.observe(Some(baseline), cut + Duration::from_millis(21));
                restored.observe(Some(baseline), target_cut + Duration::from_millis(21));
                assert_eq!(
                    source.reported_cursor(Some(baseline), cut + Duration::from_millis(22)),
                    restored
                        .reported_cursor(Some(baseline), target_cut + Duration::from_millis(22))
                );
            }
        }
    }

    #[test]
    fn cursor_settle_snapshot_preserves_distinct_timer_ages() {
        let start = Instant::now();
        let baseline = TerminalCursorState {
            x: 2,
            y: 3,
            visible: true,
            shape: 1,
        };
        let first = TerminalCursorState { y: 8, ..baseline };
        let second = TerminalCursorState { y: 9, ..baseline };
        let mut source = CursorPositionSettleState::default();
        source.observe(Some(baseline), start);
        source.observe(Some(first), start + Duration::from_millis(1));
        source.observe(Some(second), start + Duration::from_millis(11));
        let cut = start + Duration::from_millis(21);
        let snapshot = SnapshotV1::capture(&source, cut).unwrap();
        assert_eq!(snapshot.pending_age_ns, Some(20_000_000));
        assert_eq!(snapshot.candidate_age_ns, Some(10_000_000));
        let target = cut + Duration::from_secs(10);
        let restored = snapshot.restore(target).unwrap();
        for ns in [0, 79_999_999, 80_000_000, 90_000_000] {
            let delta = Duration::from_nanos(ns);
            assert_eq!(
                source.reported_cursor(Some(second), cut + delta),
                restored.reported_cursor(Some(second), target + delta)
            );
        }
        assert!(SnapshotV1::capture(&source, start).is_err());
    }

    #[test]
    fn cursor_settle_snapshot_rejects_invalid_timer_shapes() {
        let now = Instant::now();
        let base = serde_json::to_value(
            SnapshotV1::capture(&CursorPositionSettleState::default(), now).unwrap(),
        )
        .unwrap();
        for field in [
            "version",
            "settled",
            "candidate",
            "pending_age_ns",
            "candidate_age_ns",
            "candidate_jump",
        ] {
            let mut invalid = base.clone();
            invalid.as_object_mut().unwrap().remove(field);
            assert!(serde_json::from_value::<CursorPositionSettleState>(invalid).is_err());
        }
        for (field, value) in [
            ("version", serde_json::json!(2)),
            ("candidate_jump", serde_json::json!(true)),
            ("pending_age_ns", serde_json::json!(100000001)),
            ("unknown", serde_json::json!(false)),
        ] {
            let mut invalid = base.clone();
            invalid[field] = value;
            assert!(serde_json::from_value::<CursorPositionSettleState>(invalid).is_err());
        }
        let cursor = serde_json::json!({"x": 0, "y": 0, "visible": true, "shape": 1});
        let mut valid = base;
        valid["settled"] = cursor.clone();
        valid["candidate"] = cursor;
        valid["pending_age_ns"] = serde_json::json!(2);
        valid["candidate_age_ns"] = serde_json::json!(1);
        assert!(serde_json::from_value::<CursorPositionSettleState>(valid.clone()).is_ok());
        for (field, value) in [
            ("settled", serde_json::Value::Null),
            ("candidate_age_ns", serde_json::json!(3)),
            (
                "candidate",
                serde_json::json!({"x": 0, "y": 0, "visible": true, "shape": 7}),
            ),
        ] {
            let mut invalid = valid.clone();
            invalid[field] = value;
            assert!(serde_json::from_value::<CursorPositionSettleState>(invalid).is_err());
        }
        let encoded = serde_json::to_string(&valid).unwrap();
        let duplicate = encoded.replacen('{', "{\"version\":1,", 1);
        assert!(serde_json::from_str::<CursorPositionSettleState>(&duplicate).is_err());
    }
}
