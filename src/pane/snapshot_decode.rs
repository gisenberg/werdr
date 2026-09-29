//! Element-count bounds applied during tracker decoding, before allocation.

use serde::de::{Deserialize, DeserializeSeed, Deserializer, Error, SeqAccess, Visitor};
use std::{fmt, marker::PhantomData};

pub(super) struct BoundedVec<T, const LIMIT: usize>(pub Vec<T>);

struct RejectExtra;
impl<'de> DeserializeSeed<'de> for RejectExtra {
    type Value = ();

    fn deserialize<D: Deserializer<'de>>(self, _: D) -> Result<(), D::Error> {
        Err(D::Error::custom("tracker sequence exceeds limit"))
    }
}

impl<'de, T: Deserialize<'de>, const LIMIT: usize> Deserialize<'de> for BoundedVec<T, LIMIT> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct BoundedVisitor<T, const LIMIT: usize>(PhantomData<T>);
        impl<'de, T: Deserialize<'de>, const LIMIT: usize> Visitor<'de> for BoundedVisitor<T, LIMIT> {
            type Value = BoundedVec<T, LIMIT>;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                write!(formatter, "at most {LIMIT} sequence elements")
            }

            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> Result<Self::Value, A::Error> {
                if sequence.size_hint().is_some_and(|size| size > LIMIT) {
                    return Err(A::Error::custom("tracker sequence exceeds limit"));
                }
                let mut values = Vec::new();
                loop {
                    if values.len() == LIMIT {
                        // Probe for end-of-sequence without constructing a T
                        // that could allocate before we reject the extra item.
                        sequence.next_element_seed(RejectExtra)?;
                        break;
                    }
                    let Some(value) = sequence.next_element()? else {
                        break;
                    };
                    if values.len() == values.capacity() {
                        let capacity = values.capacity().saturating_mul(2).max(8).min(LIMIT);
                        values
                            .try_reserve_exact(capacity - values.len())
                            .map_err(A::Error::custom)?;
                    }
                    values.push(value);
                }
                Ok(BoundedVec(values))
            }
        }
        deserializer.deserialize_seq(BoundedVisitor::<T, LIMIT>(PhantomData))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_sequence_bounds_without_size_hints() {
        assert!(serde_json::from_str::<BoundedVec<u8, 0>>("[]").is_ok());
        assert!(serde_json::from_str::<BoundedVec<u8, 0>>("[0]").is_err());
        assert_eq!(
            serde_json::from_str::<BoundedVec<u8, 2>>("[1,2]")
                .unwrap()
                .0,
            [1, 2]
        );
        assert!(serde_json::from_str::<BoundedVec<u8, 2>>("[1,2,3]").is_err());
        struct MustNotDecode;
        impl<'de> Deserialize<'de> for MustNotDecode {
            fn deserialize<D: Deserializer<'de>>(_: D) -> Result<Self, D::Error> {
                panic!("extra element must not be constructed");
            }
        }
        assert!(serde_json::from_str::<BoundedVec<MustNotDecode, 0>>("[{}]").is_err());
    }
}
