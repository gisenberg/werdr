//! Explicit snapshot state for passive OSC collection and retained evidence.

use super::{AgentOscStateTracker, OscDebugTracker, OscStreamCollector, OscStreamState as State};
use crate::pane::snapshot_decode::BoundedVec;
use serde::{de::Error as _, ser::Error as _, Deserialize, Deserializer, Serialize, Serializer};

#[derive(Serialize)]
struct CollectorRef<'a> {
    version: u8,
    state: u8,
    body: &'a [u8],
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CollectorV1 {
    version: u8,
    state: u8,
    body: BoundedVec<u8, 4096>,
}

impl Serialize for OscStreamCollector {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if self.body.len() > Self::MAX_BODY_BYTES {
            return Err(S::Error::custom("OSC collector exceeds snapshot limit"));
        }
        let state = match self.state {
            State::Ground => 0,
            State::Escape => 1,
            State::Body => 2,
            State::BodyEscape => 3,
            State::IgnoringString => 4,
            State::IgnoringStringEscape => 5,
            State::Discarding => 6,
            State::DiscardingEscape => 7,
        };
        CollectorRef {
            version: 1,
            state,
            body: &self.body,
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for OscStreamCollector {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let snapshot = CollectorV1::deserialize(deserializer)?;
        if snapshot.version != 1 {
            return Err(D::Error::custom("unsupported OSC collector version"));
        }
        let state = match snapshot.state {
            0 => State::Ground,
            1 => State::Escape,
            2 => State::Body,
            3 => State::BodyEscape,
            4 => State::IgnoringString,
            5 => State::IgnoringStringEscape,
            6 => State::Discarding,
            7 => State::DiscardingEscape,
            _ => return Err(D::Error::custom("invalid OSC collector state")),
        };
        if (!snapshot.body.0.is_empty() && !matches!(state, State::Body | State::BodyEscape))
            || snapshot.body.0.contains(&7)
        {
            return Err(D::Error::custom("invalid OSC collector body"));
        }
        Ok(Self {
            state,
            body: snapshot.body.0,
        })
    }
}

// Encode UTF-8 strings as bounded byte arrays so untrusted text cannot allocate
// an unbounded decoded String before the transport's field limit is checked.
// Required-field deserializers below distinguish null from an absent field.
struct OptionalText<const LIMIT: usize>(Option<String>);
impl<'de, const LIMIT: usize> Deserialize<'de> for OptionalText<LIMIT> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Option::<BoundedVec<u8, LIMIT>>::deserialize(deserializer)?
            .map(|bytes| String::from_utf8(bytes.0).map_err(D::Error::custom))
            .transpose()
            .map(Self)
    }
}

#[derive(Serialize)]
struct AgentRef<'a> {
    version: u8,
    collector: &'a OscStreamCollector,
    latest_title: Option<&'a [u8]>,
    terminal_title: Option<&'a [u8]>,
    latest_progress: Option<&'a [u8]>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentV1 {
    version: u8,
    collector: OscStreamCollector,
    #[serde(deserialize_with = "OptionalText::deserialize")]
    latest_title: OptionalText<1024>,
    // Legacy restore can seed this independently of sanitized agent evidence.
    // Bound snapshot transport without truncating that distinct source value.
    #[serde(deserialize_with = "OptionalText::deserialize")]
    terminal_title: OptionalText<16384>,
    #[serde(deserialize_with = "OptionalText::deserialize")]
    latest_progress: OptionalText<1024>,
}

impl Serialize for AgentOscStateTracker {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if self.latest_title.as_ref().is_some_and(|s| s.len() > 1024)
            || self
                .latest_progress
                .as_ref()
                .is_some_and(|s| s.len() > 1024)
            || self
                .terminal_title
                .as_ref()
                .is_some_and(|s| s.len() > 16384)
        {
            return Err(S::Error::custom("agent OSC text exceeds snapshot limit"));
        }
        AgentRef {
            version: 1,
            collector: &self.collector,
            latest_title: self.latest_title.as_deref().map(str::as_bytes),
            terminal_title: self.terminal_title.as_deref().map(str::as_bytes),
            latest_progress: self.latest_progress.as_deref().map(str::as_bytes),
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for AgentOscStateTracker {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let snapshot = AgentV1::deserialize(deserializer)?;
        if snapshot.version != 1 {
            return Err(D::Error::custom("unsupported agent OSC snapshot version"));
        }
        for text in [&snapshot.latest_title.0, &snapshot.latest_progress.0]
            .into_iter()
            .flatten()
        {
            if text.chars().count() > super::AGENT_OSC_MAX_CHARS
                || text.chars().any(char::is_control)
            {
                return Err(D::Error::custom("invalid retained agent OSC text"));
            }
        }
        Ok(Self {
            collector: snapshot.collector,
            latest_title: snapshot.latest_title.0,
            terminal_title: snapshot.terminal_title.0,
            latest_progress: snapshot.latest_progress.0,
        })
    }
}

#[derive(Serialize)]
struct DebugRef<'a> {
    version: u8,
    enabled: bool,
    collector: &'a OscStreamCollector,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DebugV1 {
    version: u8,
    enabled: bool,
    collector: OscStreamCollector,
}

impl Serialize for OscDebugTracker {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if !self.pending.is_empty() {
            return Err(S::Error::custom(
                "OSC diagnostics must be drained before capture",
            ));
        }
        DebugRef {
            version: 1,
            enabled: self.enabled,
            collector: &self.collector,
        }
        .serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for OscDebugTracker {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let snapshot = DebugV1::deserialize(deserializer)?;
        if snapshot.version != 1 {
            return Err(D::Error::custom("unsupported debug OSC snapshot version"));
        }
        Ok(Self {
            enabled: snapshot.enabled,
            collector: snapshot.collector,
            pending: Vec::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn osc_snapshot_preserves_retained_evidence_and_diagnostics_at_every_cut() {
        let sequences = [
            "\x1b]2;title 🦀\x07\x1b]9;4;3;\x1b\\\x1b]2;\x07"
                .as_bytes()
                .to_vec(),
            b"\x1b]21337;debug\x1b\x1b\x07\x1bPignored\x1b\\".to_vec(),
            [
                b"\x1b]2;".as_slice(),
                &vec![b'x'; 4097],
                b"\x1b\\\x1b]9;\x07",
            ]
            .concat(),
        ];
        for sequence in sequences {
            for cut in 0..=sequence.len() {
                let mut agent = AgentOscStateTracker::default();
                let mut debug = OscDebugTracker {
                    enabled: true,
                    collector: OscStreamCollector::default(),
                    pending: Vec::new(),
                };
                agent.observe(b"\x1b]2;prior\x07\x1b]9;4;0;\x07");
                agent.clear_retained();
                agent.observe(&sequence[..cut]);
                debug.observe(&sequence[..cut]);
                debug.drain_pending();
                let restored: AgentOscStateTracker =
                    serde_json::from_slice(&serde_json::to_vec(&agent).unwrap()).unwrap();
                let mut restored: AgentOscStateTracker =
                    serde_json::from_slice(&serde_json::to_vec(&restored).unwrap()).unwrap();
                let mut restored_debug: OscDebugTracker =
                    serde_json::from_slice(&serde_json::to_vec(&debug).unwrap()).unwrap();
                for suffix in [
                    &sequence[cut..],
                    b"\x07\x1b]2;future\x07\x1b]9;4;1;\x07".as_slice(),
                ] {
                    assert_eq!(agent.observe(suffix), restored.observe(suffix));
                    debug.observe(suffix);
                    restored_debug.observe(suffix);
                    assert_eq!(debug.drain_pending(), restored_debug.drain_pending());
                    assert_eq!(
                        serde_json::to_value(&agent).unwrap(),
                        serde_json::to_value(&restored).unwrap()
                    );
                    assert_eq!(
                        serde_json::to_value(&debug).unwrap(),
                        serde_json::to_value(&restored_debug).unwrap()
                    );
                }
            }
        }
    }

    #[test]
    fn osc_snapshot_preserves_collector_boundaries_and_rejects_invalid_state() {
        for length in [4095, 4096] {
            let mut original = OscStreamCollector::default();
            let prefix = [b"\x1b]".as_slice(), &vec![b'x'; length], b"\x1b"].concat();
            original.observe(&prefix, |_| panic!("unfinished body"));
            let mut restored: OscStreamCollector =
                serde_json::from_slice(&serde_json::to_vec(&original).unwrap()).unwrap();
            assert_eq!(restored.body.len(), length);
            original.observe(b"x", |_| panic!("overflow must discard"));
            restored.observe(b"x", |_| panic!("overflow must discard"));
            assert_eq!(original.state, State::Discarding);
            assert_eq!(
                serde_json::to_value(&original).unwrap(),
                serde_json::to_value(&restored).unwrap()
            );
            let mut expected = Vec::new();
            let mut actual = Vec::new();
            original.observe(b"\x07\x1b]2;recovered\x07", |body| {
                expected.push(body.to_vec())
            });
            restored.observe(b"\x07\x1b]2;recovered\x07", |body| {
                actual.push(body.to_vec())
            });
            assert_eq!(actual, expected);
            assert_eq!(actual, [b"2;recovered".to_vec()]);
        }
        let baseline = serde_json::to_value(OscStreamCollector::default()).unwrap();
        for (field, value) in [
            ("version", serde_json::json!(2)),
            ("state", serde_json::json!(8)),
            ("body", serde_json::json!([1])),
            ("body", serde_json::json!(vec![1; 4097])),
            ("unknown", serde_json::json!(null)),
        ] {
            let mut invalid = baseline.clone();
            invalid[field] = value;
            assert!(serde_json::from_slice::<OscStreamCollector>(
                &serde_json::to_vec(&invalid).unwrap()
            )
            .is_err());
        }
        assert!(serde_json::from_str::<OscStreamCollector>(
            r#"{"version":1,"state":2,"body":[7]}"#
        )
        .is_err());
        let agent: AgentOscStateTracker =
            serde_json::from_value(serde_json::to_value(AgentOscStateTracker::default()).unwrap())
                .unwrap();
        assert!(agent.latest_title.is_none());
        assert!(agent.terminal_title.is_none());
        assert!(agent.latest_progress.is_none());
    }

    #[test]
    fn osc_snapshot_rejects_pending_diagnostics_and_invalid_text() {
        let mut debug = OscDebugTracker {
            enabled: true,
            collector: OscStreamCollector::default(),
            pending: Vec::new(),
        };
        debug.observe(b"\x1b]2;hello\x07");
        let pending = debug.pending.clone();
        assert!(!pending.is_empty());
        assert!(serde_json::to_vec(&debug).is_err());
        assert_eq!(debug.drain_pending(), pending);
        debug.enabled = false;
        let mut restored: OscDebugTracker =
            serde_json::from_slice(&serde_json::to_vec(&debug).unwrap()).unwrap();
        restored.observe(b"\x1b]2;ignored\x07");
        assert!(restored.pending.is_empty());
        let baseline = serde_json::to_value(AgentOscStateTracker::default()).unwrap();
        for value in [
            serde_json::json!([255]),
            serde_json::json!([7]),
            serde_json::json!(vec![b'a'; 257]),
            serde_json::json!(vec![b'a'; 1025]),
        ] {
            let mut invalid = baseline.clone();
            invalid["latest_title"] = value;
            assert!(serde_json::from_slice::<AgentOscStateTracker>(
                &serde_json::to_vec(&invalid).unwrap()
            )
            .is_err());
        }
        for field in [
            "version",
            "collector",
            "latest_title",
            "terminal_title",
            "latest_progress",
        ] {
            let mut invalid = baseline.clone();
            invalid.as_object_mut().unwrap().remove(field);
            assert!(serde_json::from_value::<AgentOscStateTracker>(invalid).is_err());
        }
        let agent = AgentOscStateTracker {
            terminal_title: Some("x".repeat(16385)),
            ..AgentOscStateTracker::default()
        };
        assert!(serde_json::to_vec(&agent).is_err());
        assert_eq!(agent.terminal_title.as_ref().unwrap().len(), 16385);
    }
}
