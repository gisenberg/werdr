//! Versioned state of an unfinished OSC 5522 write, not a terminal snapshot.
//! Includes orphaned spool bytes: replaying only the current MIME mappings
//! would change the captured transaction's remaining size budget.
//! Passwords and clipboard bytes are sensitive; never log this payload.
const std = @import("std");
const write = @import("clipboard_write.zig");
const command = @import("clipboard_command.zig");
const clipboard = @import("../clipboard.zig");
const base64 = @import("../../simd/base64.zig");
const Allocator = std.mem.Allocator;
pub const Error = error{ InvalidSnapshot, LimitExceeded, OutOfMemory };
const magic = "CLIPW1";

const Entry = struct { mime: []const u8, start: usize, len: usize };
const Alias = struct { alias: []const u8, target: []const u8 };
const View = struct {
    loc: clipboard.Location,
    max_size: usize,
    current: ?usize,
    carry: []const u8,
    id: []const u8,
    pw: []const u8,
    name: []const u8,
    spool: []const u8,
    entries: [write.max_write_mimes]Entry = undefined,
    entry_count: usize = 0,
    aliases: [write.max_write_aliases]Alias = undefined,
    alias_count: usize = 0,

    fn validate(self: *const View) Error!void {
        switch (self.loc) {
            .standard, .selection, .primary => {},
            else => return error.InvalidSnapshot,
        }
        if (self.entry_count > self.entries.len or self.alias_count > self.aliases.len or
            self.spool.len > self.max_size or self.carry.len > 3) return error.InvalidSnapshot;
        if (self.current) |index| {
            if (index >= self.entry_count) return error.InvalidSnapshot;
        } else if (self.carry.len != 0) return error.InvalidSnapshot;
        try text(self.id, command.max_id_len, false);
        // IDs are interpolated verbatim into future PTY responses. Preserve
        // the parser's sanitized alphabet rather than accepting framing bytes.
        for (self.id) |c| {
            if (!std.ascii.isAlphanumeric(c) and c != '-' and c != '_' and c != '+' and c != '.') return error.InvalidSnapshot;
        }
        try text(self.pw, command.max_pw_len, false);
        try text(self.name, command.max_name_len, false);
        // Validate the partial base64 group through the production decoder.
        var decoder: base64.Streaming = .{};
        var empty: [0]u8 = .{};
        _ = decoder.feed(self.carry, &empty) catch return error.InvalidSnapshot;
        for (self.entries[0..self.entry_count], 0..) |entry, i| {
            try text(entry.mime, command.max_mime_len, true);
            if (entry.start > self.spool.len or entry.len > self.spool.len - entry.start) return error.InvalidSnapshot;
            for (self.entries[0..i]) |prior| {
                if (std.mem.eql(u8, prior.mime, entry.mime)) return error.InvalidSnapshot;
            }
        }
        for (self.aliases[0..self.alias_count], 0..) |alias, i| {
            try text(alias.alias, command.max_mime_len, true);
            try text(alias.target, command.max_mime_len, true);
            for (self.aliases[0..i]) |prior| {
                if (std.mem.eql(u8, prior.alias, alias.alias)) return error.InvalidSnapshot;
            }
        }
    }
};

fn text(value: []const u8, max: usize, nonempty: bool) Error!void {
    if (value.len > max or (nonempty and value.len == 0) or !std.unicode.utf8ValidateSlice(value)) return error.InvalidSnapshot;
}

const Reader = struct {
    bytes: []const u8,
    offset: usize = 0,
    fn take(self: *Reader, len: usize) Error![]const u8 {
        if (len > self.bytes.len - self.offset) return error.InvalidSnapshot;
        const result = self.bytes[self.offset..][0..len];
        self.offset += len;
        return result;
    }
    fn byte(self: *Reader) Error!u8 {
        return (try self.take(1))[0];
    }
    fn int(self: *Reader) Error!usize {
        const value = std.mem.readInt(u64, (try self.take(8))[0..8], .little);
        return std.math.cast(usize, value) orelse error.InvalidSnapshot;
    }
    fn string(self: *Reader, max: usize) Error![]const u8 {
        const len = try self.int();
        if (len > max) return error.InvalidSnapshot;
        return self.take(len);
    }
};

const Writer = struct {
    bytes: []u8,
    offset: usize = 0,
    fn put(self: *Writer, value: []const u8) void {
        @memcpy(self.bytes[self.offset..][0..value.len], value);
        self.offset += value.len;
    }
    fn byte(self: *Writer, value: u8) void {
        self.put(&.{value});
    }
    fn int(self: *Writer, value: usize) void {
        std.mem.writeInt(u64, self.bytes[self.offset..][0..8], value, .little);
        self.offset += 8;
    }
    fn string(self: *Writer, value: []const u8) void {
        self.int(value.len);
        self.put(value);
    }
};

fn addSize(total: *usize, value: usize, limit: usize) Error!void {
    total.* = std.math.add(usize, total.*, value) catch return error.LimitExceeded;
    if (total.* > limit) return error.LimitExceeded;
}

/// One exact-sized allocation after validation and checked size accounting.
/// `limit` bounds encoded bytes, not allocator bookkeeping or total RSS.
pub fn encode(alloc: Allocator, state: *const write.WriteState, limit: usize) Error![]u8 {
    if (state.decoder.carry_len > 3 or state.entries.items.len > write.max_write_mimes or
        state.aliases.items.len > write.max_write_aliases) return error.InvalidSnapshot;
    var view: View = .{ .loc = state.loc, .max_size = state.max_size, .current = state.current, .carry = state.decoder.carry[0..state.decoder.carry_len], .id = state.id, .pw = state.pw, .name = state.name, .spool = state.spool.items, .entry_count = state.entries.items.len, .alias_count = state.aliases.items.len };
    for (state.entries.items, 0..) |entry, i| view.entries[i] = .{ .mime = entry.mime, .start = entry.start, .len = entry.len };
    for (state.aliases.items, 0..) |alias, i| view.aliases[i] = .{ .alias = alias.alias, .target = alias.target };
    try view.validate();
    var size: usize = 0;
    try addSize(&size, magic.len + 1 + 8 + 1 + 1 + view.carry.len + 2, limit);
    for ([_][]const u8{ view.id, view.pw, view.name, view.spool }) |value| {
        try addSize(&size, 8, limit);
        try addSize(&size, value.len, limit);
    }
    for (view.entries[0..view.entry_count]) |entry| {
        try addSize(&size, 24, limit);
        try addSize(&size, entry.mime.len, limit);
    }
    for (view.aliases[0..view.alias_count]) |alias| {
        try addSize(&size, 16, limit);
        try addSize(&size, alias.alias.len, limit);
        try addSize(&size, alias.target.len, limit);
    }
    const bytes = try alloc.alloc(u8, size);
    var writer: Writer = .{ .bytes = bytes };
    writer.put(magic);
    writer.byte(@intCast(@intFromEnum(view.loc)));
    writer.int(view.max_size);
    writer.byte(if (view.current) |index| @intCast(index) else 255);
    writer.byte(@intCast(view.carry.len));
    writer.put(view.carry);
    for ([_][]const u8{ view.id, view.pw, view.name, view.spool }) |value| writer.string(value);
    writer.byte(@intCast(view.entry_count));
    for (view.entries[0..view.entry_count]) |entry| {
        writer.string(entry.mime);
        writer.int(entry.start);
        writer.int(entry.len);
    }
    writer.byte(@intCast(view.alias_count));
    for (view.aliases[0..view.alias_count]) |alias| {
        writer.string(alias.alias);
        writer.string(alias.target);
    }
    std.debug.assert(writer.offset == bytes.len);
    return bytes;
}

/// Preflight into bounded borrowed views before allocating. The returned state
/// owns all data and must be deinitialized with `alloc`. No callback is emitted
/// and no existing transaction is modified, including on allocation failure.
/// The input bound includes all variable payloads; arena slack and fixed state
/// overhead are separate. This is not a process-wide allocation budget.
pub fn decode(alloc: Allocator, bytes: []const u8, limit: usize) Error!write.WriteState {
    if (bytes.len > limit) return error.LimitExceeded;
    var reader: Reader = .{ .bytes = bytes };
    if (!std.mem.eql(u8, try reader.take(magic.len), magic)) return error.InvalidSnapshot;
    const loc: clipboard.Location = @enumFromInt(try reader.byte());
    const max_size = try reader.int();
    const current = try reader.byte();
    const carry_len = try reader.byte();
    if (carry_len > 3) return error.InvalidSnapshot;
    var view: View = .{ .loc = loc, .max_size = max_size, .current = if (current == 255) null else current, .carry = try reader.take(carry_len), .id = try reader.string(command.max_id_len), .pw = try reader.string(command.max_pw_len), .name = try reader.string(command.max_name_len), .spool = try reader.string(max_size) };
    view.entry_count = try reader.byte();
    if (view.entry_count > view.entries.len) return error.InvalidSnapshot;
    for (view.entries[0..view.entry_count]) |*entry| entry.* = .{ .mime = try reader.string(command.max_mime_len), .start = try reader.int(), .len = try reader.int() };
    view.alias_count = try reader.byte();
    if (view.alias_count > view.aliases.len) return error.InvalidSnapshot;
    for (view.aliases[0..view.alias_count]) |*alias| alias.* = .{ .alias = try reader.string(command.max_mime_len), .target = try reader.string(command.max_mime_len) };
    if (reader.offset != bytes.len) return error.InvalidSnapshot;
    try view.validate();
    var result = try write.WriteState.init(alloc, &.{ .op = .write, .loc = view.loc, .id = view.id, .pw = view.pw, .name = view.name }, .{ .max_size = view.max_size });
    errdefer result.deinit(alloc);
    try result.spool.appendSlice(alloc, view.spool);
    for (view.entries[0..view.entry_count]) |entry| {
        try result.entries.append(alloc, .{ .mime = try result.arena.allocator().dupe(u8, entry.mime), .start = entry.start, .len = entry.len });
    }
    for (view.aliases[0..view.alias_count]) |alias| {
        try result.aliases.append(alloc, .{ .alias = try result.arena.allocator().dupe(u8, alias.alias), .target = try result.arena.allocator().dupe(u8, alias.target) });
    }
    result.current = view.current;
    @memcpy(result.decoder.carry[0..view.carry.len], view.carry);
    result.decoder.carry_len = @intCast(view.carry.len);
    return result;
}

fn expectEquivalent(a: *const write.WriteState, b: *const write.WriteState) !void {
    const testing = std.testing;
    const left = try encode(testing.allocator, a, 1 << 20);
    defer testing.allocator.free(left);
    const right = try encode(testing.allocator, b, 1 << 20);
    defer testing.allocator.free(right);
    try testing.expectEqualSlices(u8, left, right);
}

test "clipboard snapshot every base64 cut and repeated padded feeds" {
    const testing = std.testing;
    const alloc = testing.allocator;
    const data: command.Metadata = .{ .op = .wdata, .mime = "text/plain" };
    for ([_][]const u8{ "AAEC/w==", "SGVsbG8=", "YQ==" }) |payload| {
        for (0..payload.len + 1) |cut| {
            var source = try write.WriteState.init(alloc, &.{ .op = .write, .id = "sample", .pw = "secret", .name = "app" }, .{ .max_size = 100 });
            defer source.deinit(alloc);
            try source.data(alloc, &data, payload[0..cut]);
            const bytes = try encode(alloc, &source, 1 << 20);
            defer alloc.free(bytes);
            var restored = try decode(alloc, bytes, bytes.len);
            defer restored.deinit(alloc);
            try expectEquivalent(&source, &restored);
            try source.data(alloc, &data, payload[cut..]);
            try restored.data(alloc, &data, payload[cut..]);
            // A padded group does not permanently close the decoder.
            try source.data(alloc, &data, "V29ybGQ=");
            try restored.data(alloc, &data, "V29ybGQ=");
            try expectEquivalent(&source, &restored);
            var a = try source.commit(alloc);
            defer a.deinit(alloc);
            var b = try restored.commit(alloc);
            defer b.deinit(alloc);
            try testing.expectEqualSlices(u8, a.contents[0].data, b.contents[0].data);
            // The public WriteState remains a valid domain object after commit.
            try expectEquivalent(&source, &restored);
        }
    }
}

test "clipboard snapshot orphaned spool aliases and captured size limit" {
    const testing = std.testing;
    const alloc = testing.allocator;
    var source = try write.WriteState.init(alloc, &.{ .op = .write, .loc = .primary }, .{ .max_size = 6 });
    defer source.deinit(alloc);
    const first: command.Metadata = .{ .op = .wdata, .mime = "a" };
    const second: command.Metadata = .{ .op = .wdata, .mime = "b" };
    try source.data(alloc, &first, "YWJj"); // abc
    try source.data(alloc, &second, "ZA=="); // d
    try source.data(alloc, &first, "ZQ=="); // e, overwrites a but retains abc
    try source.alias(alloc, &.{ .op = .walias, .mime = "a" }, "Yw=="); // c -> a
    try source.alias(alloc, &.{ .op = .walias, .mime = "c" }, "ZA=="); // d -> c
    try source.alias(alloc, &.{ .op = .walias, .mime = "b" }, "Yw=="); // c -> b
    const bytes = try encode(alloc, &source, 1 << 20);
    defer alloc.free(bytes);
    var restored = try decode(alloc, bytes, bytes.len);
    defer restored.deinit(alloc);
    try expectEquivalent(&source, &restored);
    try testing.expectEqualStrings("abcde", restored.spool.items);
    try testing.expectEqual(@as(usize, 4), restored.entries.items[0].start);
    try testing.expectEqual(@as(usize, 0), restored.entries.items[0].len);
    var committed = try restored.commit(alloc);
    defer committed.deinit(alloc);
    try testing.expectEqual(@as(usize, 4), committed.contents.len);
    try testing.expectEqualStrings("e", committed.contents[0].data);
    try testing.expectEqualStrings("d", committed.contents[2].data);
    try testing.expectEqualStrings("d", committed.contents[3].data);
    var limited = try decode(alloc, bytes, bytes.len);
    defer limited.deinit(alloc);
    try testing.expectError(error.TooLarge, source.data(alloc, &first, "Zmdo"));
    try testing.expectError(error.TooLarge, limited.data(alloc, &first, "Zmdo"));
}

test "clipboard snapshot full MIME table permits null current" {
    const testing = std.testing;
    const alloc = testing.allocator;
    var source = try write.WriteState.init(alloc, &.{ .op = .write }, .{});
    defer source.deinit(alloc);
    for (0..write.max_write_mimes) |i| {
        var buf: [32]u8 = undefined;
        const mime = try std.fmt.bufPrint(&buf, "mime-{d}", .{i});
        try source.data(alloc, &.{ .op = .wdata, .mime = mime }, "eA==");
    }
    try source.data(alloc, &.{ .op = .wdata, .mime = "ignored" }, "not base64!");
    try testing.expectEqual(null, source.current);
    const bytes = try encode(alloc, &source, 1 << 20);
    defer alloc.free(bytes);
    var restored = try decode(alloc, bytes, bytes.len);
    defer restored.deinit(alloc);
    try expectEquivalent(&source, &restored);
    var committed = try restored.commit(alloc);
    defer committed.deinit(alloc);
    try testing.expectEqual(write.max_write_mimes, committed.contents.len);
}

fn decodeWithAllocator(alloc: Allocator, bytes: []const u8) !void {
    var restored = try decode(alloc, bytes, bytes.len);
    defer restored.deinit(alloc);
}

test "clipboard snapshot malformed bounds and all allocation failures" {
    const testing = std.testing;
    const alloc = testing.allocator;
    var source = try write.WriteState.init(alloc, &.{ .op = .write, .id = "id", .pw = "pw", .name = "name" }, .{});
    defer source.deinit(alloc);
    try source.data(alloc, &.{ .op = .wdata, .mime = "text/plain" }, "YWJjZA");
    try source.alias(alloc, &.{ .op = .walias, .mime = "text/plain" }, "VEVYVA==");
    const bytes = try encode(alloc, &source, 1 << 20);
    defer alloc.free(bytes);
    try testing.checkAllAllocationFailures(alloc, decodeWithAllocator, .{bytes});
    try testing.expectError(error.LimitExceeded, encode(alloc, &source, bytes.len - 1));
    try testing.expectError(error.LimitExceeded, decode(alloc, bytes, bytes.len - 1));
    for (0..bytes.len) |cut| try testing.expectError(error.InvalidSnapshot, decode(.failing, bytes[0..cut], bytes.len));
    const malformed = try alloc.alloc(u8, bytes.len + 1);
    defer alloc.free(malformed);
    @memcpy(malformed[0..bytes.len], bytes);
    malformed[bytes.len] = 0;
    try testing.expectError(error.InvalidSnapshot, decode(.failing, malformed, malformed.len));
    for ([_]usize{ 0, 6, 15, 16, 17 }) |offset| {
        @memcpy(malformed[0..bytes.len], bytes);
        malformed[offset] = 254;
        try testing.expectError(error.InvalidSnapshot, decode(.failing, malformed[0..bytes.len], bytes.len));
    }
    var reader: Reader = .{ .bytes = bytes };
    _ = try reader.take(magic.len + 1 + 8 + 1);
    _ = try reader.take(try reader.byte());
    _ = try reader.int();
    const id_offset = reader.offset;
    for ([_]u8{ ':', 7, 27, '\n', 0x80 }) |invalid_id| {
        @memcpy(malformed[0..bytes.len], bytes);
        malformed[id_offset] = invalid_id;
        try testing.expectError(error.InvalidSnapshot, decode(.failing, malformed[0..bytes.len], bytes.len));
    }
}

test "clipboard snapshot sanitized ID boundary alphabet" {
    const testing = std.testing;
    const alloc = testing.allocator;
    var id: [command.max_id_len]u8 = undefined;
    const alphabet = "aAzZ09-_+.";
    for (&id, 0..) |*c, i| c.* = alphabet[i % alphabet.len];
    var source = try write.WriteState.init(alloc, &.{ .op = .write, .id = &id }, .{});
    defer source.deinit(alloc);
    const bytes = try encode(alloc, &source, 4096);
    defer alloc.free(bytes);
    var restored = try decode(alloc, bytes, bytes.len);
    defer restored.deinit(alloc);
    try testing.expectEqualSlices(u8, &id, restored.id);
    source.id = "bad:id";
    try testing.expectError(error.InvalidSnapshot, encode(.failing, &source, 4096));
}
