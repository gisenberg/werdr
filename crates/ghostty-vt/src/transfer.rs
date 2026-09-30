//! Byte encodings for moving captured state into a separate process.
//!
//! These encodings carry values only, never pointers, callbacks or file
//! descriptors. They have no cross-version compatibility guarantee: callers
//! must pair them with a codec identity that changes whenever the vendored
//! native codec or these encodings change, and must only decode state that
//! was produced by an identical codec.

use crate::{ffi, graphics_policy_snapshot::ScreenPolicy, Error};

fn invalid() -> Error {
    Error(ffi::GhosttyResult_GHOSTTY_INVALID_VALUE)
}

/// Appends little-endian scalars and length-prefixed byte strings.
#[derive(Default)]
pub struct TransferWriter {
    bytes: Vec<u8>,
}

impl TransferWriter {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn u8(&mut self, value: u8) {
        self.bytes.push(value);
    }
    pub fn u16(&mut self, value: u16) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }
    pub fn u32(&mut self, value: u32) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }
    pub fn u64(&mut self, value: u64) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }
    pub fn bool(&mut self, value: bool) {
        self.u8(u8::from(value));
    }
    pub fn bytes(&mut self, value: &[u8]) {
        self.u64(value.len() as u64);
        self.bytes.extend_from_slice(value);
    }
    pub fn finish(self) -> Vec<u8> {
        self.bytes
    }
}

/// Bounded reader for [`TransferWriter`] output. Every length is checked
/// against the remaining input before allocation.
pub struct TransferReader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> TransferReader<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }
    fn take(&mut self, len: usize) -> Result<&'a [u8], Error> {
        let end = self.offset.checked_add(len).ok_or_else(invalid)?;
        let slice = self.bytes.get(self.offset..end).ok_or_else(invalid)?;
        self.offset = end;
        Ok(slice)
    }
    fn array<const N: usize>(&mut self) -> Result<[u8; N], Error> {
        self.take(N)?.try_into().map_err(|_| invalid())
    }
    pub fn u8(&mut self) -> Result<u8, Error> {
        Ok(self.array::<1>()?[0])
    }
    pub fn u16(&mut self) -> Result<u16, Error> {
        Ok(u16::from_le_bytes(self.array()?))
    }
    pub fn u32(&mut self) -> Result<u32, Error> {
        Ok(u32::from_le_bytes(self.array()?))
    }
    pub fn u64(&mut self) -> Result<u64, Error> {
        Ok(u64::from_le_bytes(self.array()?))
    }
    pub fn bool(&mut self) -> Result<bool, Error> {
        match self.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(invalid()),
        }
    }
    pub fn bytes(&mut self) -> Result<&'a [u8], Error> {
        let len = usize::try_from(self.u64()?).map_err(|_| invalid())?;
        self.take(len)
    }
    pub fn owned_bytes(&mut self) -> Result<Vec<u8>, Error> {
        let slice = self.bytes()?;
        let mut owned = Vec::new();
        owned
            .try_reserve_exact(slice.len())
            .map_err(|_| Error(ffi::GhosttyResult_GHOSTTY_OUT_OF_MEMORY))?;
        owned.extend_from_slice(slice);
        Ok(owned)
    }
    /// Reject trailing input so a truncated or concatenated record cannot pass.
    pub fn finish(self) -> Result<(), Error> {
        if self.offset == self.bytes.len() {
            Ok(())
        } else {
            Err(invalid())
        }
    }
}

impl crate::GraphicsPolicySnapshot {
    pub fn encode_transfer(&self, writer: &mut TransferWriter) {
        writer.u32(self.features);
        writer.u32(self.flags);
        writer.u64(self.kitty_max_bytes as u64);
        writer.u64(self.glyph_max_bytes as u64);
        writer.u64(self.unknown_max_bytes as u64);
        for screen in &self.screens {
            writer.u32(screen.flags);
            writer.u64(screen.storage_limit);
            writer.bytes(&screen.directory);
        }
        writer.bool(self.png_forwarding);
        writer.bool(self.source_forwarding);
    }

    /// Decode a policy, bounding combined directory bytes like capture does.
    pub fn decode_transfer(
        reader: &mut TransferReader<'_>,
        directory_limit: usize,
    ) -> Result<Self, Error> {
        let size = |value: u64| usize::try_from(value).map_err(|_| invalid());
        let features = reader.u32()?;
        let flags = reader.u32()?;
        let kitty_max_bytes = size(reader.u64()?)?;
        let glyph_max_bytes = size(reader.u64()?)?;
        let unknown_max_bytes = size(reader.u64()?)?;
        let mut directories = 0usize;
        let mut screen = |reader: &mut TransferReader<'_>| -> Result<ScreenPolicy, Error> {
            let flags = reader.u32()?;
            let storage_limit = reader.u64()?;
            let directory = reader.bytes()?;
            directories = directories
                .checked_add(directory.len())
                .filter(|total| *total <= directory_limit)
                .ok_or(Error(ffi::GhosttyResult_GHOSTTY_LIMIT_EXCEEDED))?;
            Ok(ScreenPolicy {
                flags,
                storage_limit,
                directory: directory.to_vec(),
            })
        };
        let screens = [screen(reader)?, screen(reader)?];
        Ok(Self {
            features,
            flags,
            kitty_max_bytes,
            glyph_max_bytes,
            unknown_max_bytes,
            screens,
            png_forwarding: reader.bool()?,
            source_forwarding: reader.bool()?,
        })
    }
}

impl crate::GraphicsSnapshot {
    /// Encoded graphics state when it references no host file attachments.
    ///
    /// Native-file backed images are held as process-local attachments and
    /// cannot move through a byte stream, so this returns `None` for them.
    /// Without attachments the encoding holds only values, so it restores in
    /// another process built with an identical codec.
    pub fn transfer_bytes(&self) -> Option<&[u8]> {
        self.attachments.is_empty().then_some(self.bytes.as_slice())
    }

    /// Rebuild an attachment-free snapshot from [`Self::transfer_bytes`].
    /// Restoration still validates structure, budgets and policy.
    pub fn from_transfer_bytes(bytes: Vec<u8>) -> Self {
        Self {
            bytes,
            attachments: Default::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Terminal;

    fn terminal() -> Terminal {
        let mut terminal = Terminal::new_with_snapshot_tracking(20, 4, 100_000, 4096).unwrap();
        terminal.resize(20, 4, 8, 16).unwrap();
        terminal
    }

    #[test]
    fn scalars_and_byte_strings_round_trip_and_reject_truncation_or_trailing_data() {
        let mut writer = TransferWriter::new();
        writer.u8(7);
        writer.u16(0x1234);
        writer.u32(0xdead_beef);
        writer.u64(u64::MAX);
        writer.bool(true);
        writer.bytes(b"payload");
        let bytes = writer.finish();
        let mut reader = TransferReader::new(&bytes);
        assert_eq!(reader.u8().unwrap(), 7);
        assert_eq!(reader.u16().unwrap(), 0x1234);
        assert_eq!(reader.u32().unwrap(), 0xdead_beef);
        assert_eq!(reader.u64().unwrap(), u64::MAX);
        assert!(reader.bool().unwrap());
        assert_eq!(reader.bytes().unwrap(), b"payload");
        reader.finish().unwrap();

        let mut truncated = TransferReader::new(&bytes[..bytes.len() - 1]);
        for _ in 0..5 {
            let _ = truncated.u64();
        }
        assert!(TransferReader::new(&bytes[..bytes.len() - 1])
            .bytes()
            .is_err());
        let mut trailing = bytes.clone();
        trailing.push(0);
        let mut reader = TransferReader::new(&trailing);
        reader.u8().unwrap();
        reader.u16().unwrap();
        reader.u32().unwrap();
        reader.u64().unwrap();
        reader.bool().unwrap();
        reader.bytes().unwrap();
        assert!(reader.finish().is_err());
        assert!(TransferReader::new(&[2]).bool().is_err());
        // A declared length larger than the input never allocates.
        let mut huge = TransferWriter::new();
        huge.u64(u64::MAX);
        assert!(TransferReader::new(&huge.finish()).bytes().is_err());
    }

    #[test]
    fn graphics_policy_round_trips_through_a_byte_transfer() {
        let mut source = terminal();
        source.enable_kitty_graphics().unwrap();
        source.set_kitty_source_forwarding(true).unwrap();
        let policy = source.graphics_policy_snapshot(4096).unwrap();
        let mut writer = TransferWriter::new();
        policy.encode_transfer(&mut writer);
        let bytes = writer.finish();
        let mut reader = TransferReader::new(&bytes);
        let decoded = crate::GraphicsPolicySnapshot::decode_transfer(&mut reader, 4096).unwrap();
        reader.finish().unwrap();
        assert_eq!(decoded, policy);
        let mut destination = terminal();
        destination
            .restore_graphics_policy_snapshot(&decoded, 4096)
            .unwrap();
        assert_eq!(destination.graphics_policy_snapshot(4096).unwrap(), policy);
    }

    #[test]
    fn attachment_free_graphics_round_trip_through_bytes() {
        let limits = crate::GraphicsSnapshotLimits {
            encoded_bytes: 1 << 20,
            backing_bytes: 1 << 20,
            images: 16,
            placements: 16,
            policy_bytes: 4096,
        };
        let mut source = terminal();
        source.enable_kitty_graphics().unwrap();
        // Direct (inline) transmission keeps pixels in the snapshot itself,
        // including a partial upload continued after the transfer.
        source.write(b"\x1b_Ga=T,f=32,s=1,v=1,i=1,q=2;AQIDBA==\x1b\\");
        source.write(b"\x1b[?1049h\x1b_Ga=T,f=32,s=1,v=1,i=2,q=2;BAUGBw==\x1b\\");
        source.write(b"\x1b_Ga=t,f=32,s=1,v=1,i=3,m=1,q=2;AQI=\x1b\\");
        let core = source.snapshot_bytes().unwrap();
        let mut writer = TransferWriter::new();
        source
            .graphics_policy_snapshot(4096)
            .unwrap()
            .encode_transfer(&mut writer);
        let policy = writer.finish();
        let bytes = source
            .graphics_snapshot(limits)
            .unwrap()
            .transfer_bytes()
            .expect("inline images need no attachments")
            .to_vec();
        drop(source);
        let mut dest = Terminal::from_snapshot(&core, 4096).unwrap();
        let mut reader = TransferReader::new(&policy);
        let policy = crate::GraphicsPolicySnapshot::decode_transfer(&mut reader, 4096).unwrap();
        reader.finish().unwrap();
        dest.restore_graphics_policy_snapshot(&policy, 4096)
            .unwrap();
        dest.restore_graphics_snapshot(
            &crate::GraphicsSnapshot::from_transfer_bytes(bytes),
            limits,
        )
        .unwrap();
        assert_eq!(dest.kitty_image_placements().unwrap()[0].data, [4, 5, 6, 7]);
        dest.write(b"\x1b_Gm=0;AwQ=\x1b\\\x1b_Ga=p,i=3,p=3,q=2\x1b\\");
        assert!(dest
            .kitty_image_placements()
            .unwrap()
            .iter()
            .any(|p| p.data == [1, 2, 3, 4]));
        dest.write(b"\x1b[?1049l");
        assert_eq!(dest.kitty_image_placements().unwrap()[0].data, [1, 2, 3, 4]);
    }
}
