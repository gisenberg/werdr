//! Versioned cursor-style parser continuation. This is not a runtime handoff.

use super::{DecscusrParseState, DecscusrTracker};
use serde::{de::Error as _, Deserialize, Deserializer, Serialize, Serializer};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ParserV1 {
    phase: u8,
    #[serde(deserialize_with = "Option::deserialize")]
    first_param: Option<u16>,
    collecting_first_param: bool,
    has_space_intermediate: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SnapshotV1 {
    version: u8,
    parser: ParserV1,
    cursor_shape_overridden: bool,
}

impl Serialize for DecscusrTracker {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let parser = match self.state {
            DecscusrParseState::Ground | DecscusrParseState::Escape => ParserV1 {
                phase: u8::from(matches!(self.state, DecscusrParseState::Escape)),
                first_param: None,
                collecting_first_param: false,
                has_space_intermediate: false,
            },
            DecscusrParseState::Csi {
                first_param,
                collecting_first_param,
                has_space_intermediate,
            } => ParserV1 {
                phase: 2,
                first_param,
                collecting_first_param,
                has_space_intermediate,
            },
        };
        SnapshotV1 {
            version: 1,
            parser,
            cursor_shape_overridden: self.cursor_shape_overridden,
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for DecscusrTracker {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let snapshot = SnapshotV1::deserialize(deserializer)?;
        if snapshot.version != 1 {
            return Err(D::Error::custom(
                "unsupported cursor-style snapshot version",
            ));
        }
        let ParserV1 {
            phase,
            first_param,
            collecting_first_param,
            has_space_intermediate,
        } = snapshot.parser;
        let state = match phase {
            0 | 1 => {
                if first_param.is_some() || collecting_first_param || has_space_intermediate {
                    return Err(D::Error::custom("unexpected cursor-style parser fields"));
                }
                if phase == 0 {
                    DecscusrParseState::Ground
                } else {
                    DecscusrParseState::Escape
                }
            }
            2 => {
                if has_space_intermediate && collecting_first_param {
                    return Err(D::Error::custom("inconsistent cursor-style parser state"));
                }
                DecscusrParseState::Csi {
                    first_param,
                    collecting_first_param,
                    has_space_intermediate,
                }
            }
            _ => return Err(D::Error::custom("unknown cursor-style parser phase")),
        };
        Ok(Self {
            state,
            cursor_shape_overridden: snapshot.cursor_shape_overridden,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_snapshot_preserves_override_and_parser_at_every_cut() {
        for sequence in [
            b"\x1b[2 q\x1b[0 q".as_slice(),
            b"\x1b[; q",
            b"\x1b[1:2 q",
            b"\x1b[65536 q",
            b"\x1b[999999999999999 q",
            b"\x1b\x1b[3 \x1b[5 q",
            b"\x1b[?1 q",
            b"\x1b[\x00",
        ] {
            for cut in 0..=sequence.len() {
                let mut original = DecscusrTracker::default();
                original.observe(b"\x1b[6 q");
                original.observe(&sequence[..cut]);
                let restored: DecscusrTracker =
                    serde_json::from_slice(&serde_json::to_vec(&original).unwrap()).unwrap();
                let mut restored: DecscusrTracker =
                    serde_json::from_slice(&serde_json::to_vec(&restored).unwrap()).unwrap();
                for suffix in [&sequence[cut..], b"\x1b[0 q".as_slice(), b"\x1b[1 q"] {
                    original.observe(suffix);
                    restored.observe(suffix);
                    assert_eq!(
                        original.cursor_shape_overridden(),
                        restored.cursor_shape_overridden()
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
    fn cursor_snapshot_rejects_malformed_and_incomplete_schema() {
        let mut original = DecscusrTracker::default();
        original.observe(b"\x1b[");
        let baseline = serde_json::to_value(&original).unwrap();
        assert!(baseline["parser"]["first_param"].is_null());
        let _: DecscusrTracker = serde_json::from_value(baseline.clone()).unwrap();
        for field in [
            "phase",
            "first_param",
            "collecting_first_param",
            "has_space_intermediate",
        ] {
            let mut invalid = baseline.clone();
            invalid["parser"].as_object_mut().unwrap().remove(field);
            assert!(serde_json::from_value::<DecscusrTracker>(invalid).is_err());
        }
        for (field, value) in [
            ("phase", serde_json::json!(3)),
            ("phase", serde_json::json!(0)),
            ("first_param", serde_json::json!(65536)),
            ("has_space_intermediate", serde_json::json!(true)),
            ("unknown", serde_json::json!(true)),
        ] {
            let mut invalid = baseline.clone();
            invalid["parser"][field] = value;
            assert!(serde_json::from_value::<DecscusrTracker>(invalid).is_err());
        }
        for field in ["version", "parser", "cursor_shape_overridden"] {
            let mut invalid = baseline.clone();
            invalid.as_object_mut().unwrap().remove(field);
            assert!(serde_json::from_value::<DecscusrTracker>(invalid).is_err());
        }
        let mut invalid = baseline;
        invalid["version"] = serde_json::json!(2);
        assert!(serde_json::from_value::<DecscusrTracker>(invalid).is_err());
        let valid = serde_json::to_string(&DecscusrTracker::default()).unwrap();
        let duplicate = valid.replacen('{', "{\"version\":1,", 1);
        assert!(serde_json::from_str::<DecscusrTracker>(&duplicate).is_err());
        // Reject the unknown field or wrong scalar type without buffering its value.
        for input in [
            r#"{"version":1,"parser":{"unknown":["#,
            r#"{"version":1,"parser":{"phase":["#,
        ] {
            let error = serde_json::from_str::<DecscusrTracker>(input)
                .err()
                .unwrap();
            assert!(error.is_data(), "{error}");
        }
    }
}
