//! Retained Windows fallback data, separate from platform rendering operations.
//! Oversized snapshots are rejected without truncating retained text.
//! The 2,000-row transport bound applies to both vectors; the live last_snapshot
//! can exceed it on tall terminals. This is not a live-state invariant.
//! These fields do not include the native tracked-row observer required by refresh.

use crate::pane::snapshot_decode::BoundedVec;
use serde::{de::Error as _, ser::Error as _, Deserialize, Deserializer, Serialize, Serializer};

pub(super) const CACHE_LINES: usize = 2000;
const MAX_LINE_BYTES: usize = 16_384;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct Cache {
    pub(super) rows: Vec<RenderedLine>,
    pub(super) last_snapshot: Vec<RenderedLine>,
    pub(super) usable: bool,
    pub(super) last_scrollbar: Option<(usize, usize)>,
    pub(super) needs_refresh: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct RenderedLine {
    pub(super) text: String,
    pub(super) soft_wrapped: bool,
    pub(super) wrap_continuation: bool,
}

#[derive(Serialize)]
struct LineRef<'a> {
    text: &'a [u8],
    soft_wrapped: bool,
    wrap_continuation: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LineV1 {
    text: BoundedVec<u8, MAX_LINE_BYTES>,
    soft_wrapped: bool,
    wrap_continuation: bool,
}

impl Serialize for RenderedLine {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if self.text.len() > MAX_LINE_BYTES {
            return Err(S::Error::custom("fallback line exceeds snapshot limit"));
        }
        LineRef {
            text: self.text.as_bytes(),
            soft_wrapped: self.soft_wrapped,
            wrap_continuation: self.wrap_continuation,
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for RenderedLine {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let line = LineV1::deserialize(deserializer)?;
        Ok(Self {
            text: String::from_utf8(line.text.0).map_err(D::Error::custom)?,
            soft_wrapped: line.soft_wrapped,
            wrap_continuation: line.wrap_continuation,
        })
    }
}

#[derive(Serialize)]
struct CacheRef<'a> {
    version: u8,
    rows: &'a [RenderedLine],
    last_snapshot: &'a [RenderedLine],
    usable: bool,
    last_scrollbar: Option<(u64, u64)>,
    needs_refresh: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CacheV1 {
    version: u8,
    rows: BoundedVec<RenderedLine, CACHE_LINES>,
    last_snapshot: BoundedVec<RenderedLine, CACHE_LINES>,
    usable: bool,
    #[serde(deserialize_with = "Option::deserialize")]
    last_scrollbar: Option<(u64, u64)>,
    needs_refresh: bool,
}

impl Serialize for Cache {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if self.rows.len() > CACHE_LINES || self.last_snapshot.len() > CACHE_LINES {
            return Err(S::Error::custom("fallback rows exceed snapshot limit"));
        }
        CacheRef {
            version: 1,
            rows: &self.rows,
            last_snapshot: &self.last_snapshot,
            usable: self.usable,
            last_scrollbar: self
                .last_scrollbar
                .map(|(total, len)| (total as u64, len as u64)),
            needs_refresh: self.needs_refresh,
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for Cache {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let cache = CacheV1::deserialize(deserializer)?;
        if cache.version != 1 {
            return Err(D::Error::custom("unsupported fallback snapshot version"));
        }
        let last_scrollbar = cache
            .last_scrollbar
            .map(|(total, len)| {
                Ok((
                    usize::try_from(total).map_err(D::Error::custom)?,
                    usize::try_from(len).map_err(D::Error::custom)?,
                ))
            })
            .transpose()?;
        Ok(Self {
            rows: cache.rows.0,
            last_snapshot: cache.last_snapshot.0,
            usable: cache.usable,
            last_scrollbar,
            needs_refresh: cache.needs_refresh,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(text: &str, soft_wrapped: bool, wrap_continuation: bool) -> RenderedLine {
        RenderedLine {
            text: text.into(),
            soft_wrapped,
            wrap_continuation,
        }
    }

    #[test]
    fn windows_fallback_snapshot_preserves_retained_rows_and_refresh_state() {
        for usable in [false, true] {
            for needs_refresh in [false, true] {
                for last_scrollbar in [None, Some((0, 0)), Some((12_345, 80))] {
                    let source = Cache {
                        rows: vec![
                            line("retained 日本語", true, false),
                            line("continuation", false, true),
                        ],
                        last_snapshot: vec![line("different latest screen", false, false)],
                        usable,
                        needs_refresh,
                        last_scrollbar,
                    };
                    let restored: Cache =
                        serde_json::from_slice(&serde_json::to_vec(&source).unwrap()).unwrap();
                    assert_eq!(source, restored);
                    let repeated: Cache =
                        serde_json::from_slice(&serde_json::to_vec(&restored).unwrap()).unwrap();
                    assert_eq!(source, repeated);
                }
            }
        }
    }

    #[test]
    fn windows_fallback_snapshot_rejects_oversize_without_mutation() {
        let boundary = line(&"x".repeat(MAX_LINE_BYTES), true, true);
        let restored: RenderedLine =
            serde_json::from_slice(&serde_json::to_vec(&boundary).unwrap()).unwrap();
        assert_eq!(boundary, restored);
        let unicode = line(&"é".repeat(MAX_LINE_BYTES / 2), false, true);
        let restored: RenderedLine =
            serde_json::from_slice(&serde_json::to_vec(&unicode).unwrap()).unwrap();
        assert_eq!(unicode, restored);
        let mut oversized = boundary.clone();
        oversized.text.push('x');
        assert!(serde_json::to_vec(&oversized).is_err());
        assert_eq!(oversized.text.len(), MAX_LINE_BYTES + 1);
        let mut encoded = serde_json::to_value(&boundary).unwrap();
        encoded["text"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!(120));
        assert!(serde_json::from_value::<RenderedLine>(encoded).is_err());
        for last in [false, true] {
            let mut source = Cache::default();
            let rows = if last {
                &mut source.last_snapshot
            } else {
                &mut source.rows
            };
            rows.resize(CACHE_LINES, line("x", false, false));
            let restored: Cache =
                serde_json::from_slice(&serde_json::to_vec(&source).unwrap()).unwrap();
            assert_eq!(source, restored);
            let mut invalid = serde_json::to_value(&source).unwrap();
            invalid[if last { "last_snapshot" } else { "rows" }].as_array_mut().unwrap().push(serde_json::json!({"text": [], "soft_wrapped": false, "wrap_continuation": false}));
            assert!(
                serde_json::from_slice::<Cache>(&serde_json::to_vec(&invalid).unwrap()).is_err()
            );
            let rows = if last {
                &mut source.last_snapshot
            } else {
                &mut source.rows
            };
            rows.push(line("extra", false, false));
            let before = source.clone();
            assert!(serde_json::to_vec(&source).is_err());
            assert_eq!(source, before);
        }
    }

    #[test]
    fn windows_fallback_snapshot_rejects_invalid_schema() {
        let baseline = serde_json::to_value(Cache::default()).unwrap();
        for field in [
            "version",
            "rows",
            "last_snapshot",
            "usable",
            "last_scrollbar",
            "needs_refresh",
        ] {
            let mut invalid = baseline.clone();
            invalid.as_object_mut().unwrap().remove(field);
            assert!(serde_json::from_value::<Cache>(invalid).is_err());
        }
        for (field, value) in [
            ("version", serde_json::json!(2)),
            ("unknown", serde_json::json!(0)),
            ("last_scrollbar", serde_json::json!([1])),
        ] {
            let mut invalid = baseline.clone();
            invalid[field] = value;
            assert!(serde_json::from_value::<Cache>(invalid).is_err());
        }
        let valid = serde_json::to_string(&Cache::default()).unwrap();
        let mut wide_metrics = baseline;
        wide_metrics["last_scrollbar"] = serde_json::json!([u64::MAX, u64::MAX]);
        let restored = serde_json::from_slice::<Cache>(&serde_json::to_vec(&wide_metrics).unwrap());
        if usize::BITS < 64 {
            assert!(restored.is_err());
        } else {
            assert_eq!(
                restored.unwrap().last_scrollbar,
                Some((usize::MAX, usize::MAX))
            );
        }
        let line_baseline = serde_json::to_value(line("", true, true)).unwrap();
        for field in ["text", "soft_wrapped", "wrap_continuation"] {
            let mut invalid = line_baseline.clone();
            invalid.as_object_mut().unwrap().remove(field);
            assert!(serde_json::from_value::<RenderedLine>(invalid).is_err());
        }
        assert!(serde_json::from_str::<Cache>(&valid.replacen('{', "{\"version\":1,", 1)).is_err());
        assert!(serde_json::from_str::<RenderedLine>(
            r#"{"text":[255],"soft_wrapped":false,"wrap_continuation":false}"#
        )
        .is_err());
    }
}
