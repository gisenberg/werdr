//! Authoritative APC parsing state. This does not preserve retained images.
//! Capture only at quiescent stream boundaries, never during command dispatch.
const std = @import("std");
const options = @import("terminal_options");
const apc = @import("apc.zig");
const Allocator = std.mem.Allocator;
pub const Error = error{ InvalidSnapshot, LimitExceeded, OutOfMemory };
const magic = "APCST1";
const header_len = 64;
const key_mask = (@as(u64, 1) << 52) - 1;
// Stable key order is a-z then A-Z, not a native struct or enum representation.

const View = struct {
    tag: u8 = 0,
    enabled: u8 = 0,
    limits_present: u8 = 0,
    kitty_state: u8 = 0,
    current: u8 = 0,
    truncated: bool = false,
    unknown_limit: usize = 0,
    kitty_limit: usize = 0,
    glyph_limit: usize = 0,
    captured_limit: usize = 0,
    keys: u64 = 0,
    values: [52]u32 = undefined,
    temp: []const u8 = "",
    data: []const u8 = "",
};

fn validate(v: *const View) Error!void {
    if (v.enabled & ~@as(u8, 3) != 0 or v.limits_present & ~@as(u8, 3) != 0) return error.InvalidSnapshot;
    if (v.limits_present & 1 == 0 and v.kitty_limit != 0) return error.InvalidSnapshot;
    if (v.limits_present & 2 == 0 and v.glyph_limit != 0) return error.InvalidSnapshot;
    if (v.keys & ~key_mask != 0 or v.temp.len > 11) return error.InvalidSnapshot;
    if (v.tag != 3 and v.truncated) return error.InvalidSnapshot;
    if (v.tag != 4 and (v.keys != 0 or v.temp.len != 0 or v.kitty_state != 0 or v.current != 0)) return error.InvalidSnapshot;
    switch (v.tag) {
        0, 1 => if (v.data.len != 0 or v.captured_limit != 0) return error.InvalidSnapshot,
        2 => if (v.data.len > apc.glyph.identifier.len or v.captured_limit != 0) return error.InvalidSnapshot,
        3 => if (v.data.len > v.captured_limit) return error.InvalidSnapshot,
        4 => {
            if (!options.kitty_graphics or v.kitty_state > 4 or v.data.len > v.captured_limit) return error.InvalidSnapshot;
            if (v.kitty_state != 4 and v.data.len != 0) return error.InvalidSnapshot;
        },
        5 => if (!options.glyph_protocol or v.data.len > v.captured_limit) return error.InvalidSnapshot,
        else => return error.InvalidSnapshot,
    }
}

fn view(h: *const apc.Handler) Error!View {
    var v: View = .{
        .enabled = @as(u8, @intFromBool(h.enabled.contains(.kitty))) | (@as(u8, @intFromBool(h.enabled.contains(.glyph))) << 1),
        .limits_present = @as(u8, @intFromBool(h.max_bytes.get(.kitty) != null)) | (@as(u8, @intFromBool(h.max_bytes.get(.glyph) != null)) << 1),
        .unknown_limit = h.unknown_max_bytes,
        .kitty_limit = h.max_bytes.get(.kitty) orelse 0,
        .glyph_limit = h.max_bytes.get(.glyph) orelse 0,
    };
    switch (h.state) {
        .inactive => {},
        .ignore => v.tag = 1,
        .identify => |*id| {
            if (id.len > id.buf.len) return error.InvalidSnapshot;
            v.tag = 2;
            v.data = id.buf[0..id.len];
        },
        .unknown => |*p| {
            v.tag = 3;
            v.data = p.data.items;
            v.captured_limit = p.max_bytes;
            v.truncated = p.truncated;
        },
        .kitty => |*p| if (comptime options.kitty_graphics) {
            v.tag = 4;
            v.captured_limit = p.max_bytes;
            v.data = p.data.items;
            v.kitty_state = switch (p.state) {
                .control_key => 0,
                .control_key_ignore => 1,
                .control_value => 2,
                .control_value_ignore => 3,
                .data => 4,
            };
            if (p.kv_temp_len > p.kv_temp.len) return error.InvalidSnapshot;
            v.temp = p.kv_temp[0..p.kv_temp_len];
            v.current = p.kv_current;
            v.keys = p.kv.present;
            // Absent values and unused temporary bytes are uninitialized.
            for (0..52) |i| if (v.keys & (@as(u64, 1) << @intCast(i)) != 0) {
                v.values[i] = p.kv.values[i];
            };
        } else return error.InvalidSnapshot,
        .glyph => |*p| if (comptime options.glyph_protocol) {
            v.tag = 5;
            v.captured_limit = p.max_bytes;
            v.data = p.data.items;
        } else return error.InvalidSnapshot,
    }
    try validate(&v);
    return v;
}

/// Limit bounds encoded bytes, not allocator overhead or retained capacities.
pub fn encode(alloc: Allocator, h: *const apc.Handler, limit: usize) Error![]u8 {
    const v = try view(h);
    const prefix = header_len + v.temp.len + 4 * @as(usize, @popCount(v.keys));
    const len = std.math.add(usize, prefix, v.data.len) catch return error.LimitExceeded;
    if (len > limit) return error.LimitExceeded;
    const bytes = try alloc.alloc(u8, len);
    @memcpy(bytes[0..6], magic);
    bytes[6] = v.tag;
    bytes[7] = v.enabled;
    bytes[8] = v.limits_present;
    bytes[9] = v.kitty_state;
    bytes[10] = @intCast(v.temp.len);
    bytes[11] = v.current;
    bytes[12] = @intFromBool(v.truncated);
    @memset(bytes[13..16], 0);
    std.mem.writeInt(u64, bytes[16..24], v.unknown_limit, .little);
    std.mem.writeInt(u64, bytes[24..32], v.kitty_limit, .little);
    std.mem.writeInt(u64, bytes[32..40], v.glyph_limit, .little);
    std.mem.writeInt(u64, bytes[40..48], v.captured_limit, .little);
    std.mem.writeInt(u64, bytes[48..56], v.data.len, .little);
    std.mem.writeInt(u64, bytes[56..64], v.keys, .little);
    @memcpy(bytes[header_len..][0..v.temp.len], v.temp);
    var pos = header_len + v.temp.len;
    for (0..52) |i| if (v.keys & (@as(u64, 1) << @intCast(i)) != 0) {
        std.mem.writeInt(u32, bytes[pos..][0..4], v.values[i], .little);
        pos += 4;
    };
    @memcpy(bytes[pos..], v.data);
    return bytes;
}

fn preflight(bytes: []const u8, limit: usize) Error!View {
    if (bytes.len > limit) return error.LimitExceeded;
    if (bytes.len < header_len or !std.mem.eql(u8, bytes[0..6], magic)) return error.InvalidSnapshot;
    if (bytes[12] > 1 or !std.mem.allEqual(u8, bytes[13..16], 0)) return error.InvalidSnapshot;
    var v: View = .{
        .tag = bytes[6],
        .enabled = bytes[7],
        .limits_present = bytes[8],
        .kitty_state = bytes[9],
        .current = bytes[11],
        .truncated = bytes[12] != 0,
        .unknown_limit = std.math.cast(usize, std.mem.readInt(u64, bytes[16..24], .little)) orelse return error.InvalidSnapshot,
        .kitty_limit = std.math.cast(usize, std.mem.readInt(u64, bytes[24..32], .little)) orelse return error.InvalidSnapshot,
        .glyph_limit = std.math.cast(usize, std.mem.readInt(u64, bytes[32..40], .little)) orelse return error.InvalidSnapshot,
        .captured_limit = std.math.cast(usize, std.mem.readInt(u64, bytes[40..48], .little)) orelse return error.InvalidSnapshot,
        .keys = std.mem.readInt(u64, bytes[56..64], .little),
    };
    const temp_len: usize = bytes[10];
    const prefix = header_len + temp_len + 4 * @as(usize, @popCount(v.keys));
    const len = std.math.cast(usize, std.mem.readInt(u64, bytes[48..56], .little)) orelse return error.InvalidSnapshot;
    if (prefix > bytes.len or len != bytes.len - prefix or v.keys & ~key_mask != 0) return error.InvalidSnapshot;
    v.temp = bytes[header_len..][0..temp_len];
    var pos = header_len + temp_len;
    for (0..52) |i| if (v.keys & (@as(u64, 1) << @intCast(i)) != 0) {
        v.values[i] = std.mem.readInt(u32, bytes[pos..][0..4], .little);
        pos += 4;
    };
    v.data = bytes[prefix..];
    try validate(&v);
    return v;
}

fn copyData(alloc: Allocator, data: []const u8) Error!std.ArrayList(u8) {
    return .fromOwnedSlice(try alloc.dupe(u8, data));
}

/// Returns an owned handler without parsing bytes or executing commands.
/// Stage this before deinitializing the old handler, including for aliased input.
pub fn decode(alloc: Allocator, bytes: []const u8, limit: usize) Error!apc.Handler {
    const v = try preflight(bytes, limit);
    var h: apc.Handler = .{ .unknown_max_bytes = v.unknown_limit, .max_bytes = .{}, .enabled = .{} };
    h.enabled.setPresent(.kitty, v.enabled & 1 != 0);
    h.enabled.setPresent(.glyph, v.enabled & 2 != 0);
    if (v.limits_present & 1 != 0) h.max_bytes.put(.kitty, v.kitty_limit);
    if (v.limits_present & 2 != 0) h.max_bytes.put(.glyph, v.glyph_limit);
    switch (v.tag) {
        0 => {},
        1 => h.state = .ignore,
        2 => {
            h.state = .{ .identify = .{ .len = @intCast(v.data.len) } };
            @memcpy(h.state.identify.buf[0..v.data.len], v.data);
        },
        3 => h.state = .{ .unknown = .{ .alloc = alloc, .data = try copyData(alloc, v.data), .max_bytes = v.captured_limit, .truncated = v.truncated } },
        4 => if (comptime options.kitty_graphics) {
            h.state = .{ .kitty = .init(alloc, v.captured_limit) };
            const p = &h.state.kitty;
            p.data = try copyData(alloc, v.data);
            p.state = switch (v.kitty_state) {
                0 => .control_key,
                1 => .control_key_ignore,
                2 => .control_value,
                3 => .control_value_ignore,
                4 => .data,
                else => unreachable,
            };
            p.kv.present = v.keys;
            for (0..52) |i| if (v.keys & (@as(u64, 1) << @intCast(i)) != 0) {
                p.kv.values[i] = v.values[i];
            };
            p.kv_current = v.current;
            p.kv_temp_len = @intCast(v.temp.len);
            @memcpy(p.kv_temp[0..v.temp.len], v.temp);
        } else unreachable,
        5 => if (comptime options.glyph_protocol) {
            h.state = .{ .glyph = .init(alloc, v.captured_limit) };
            h.state.glyph.data = try copyData(alloc, v.data);
        } else unreachable,
        else => unreachable,
    }
    return h;
}

fn roundtrip(source: *const apc.Handler) !apc.Handler {
    const alloc = std.testing.allocator;
    const bytes = try encode(alloc, source, 1 << 20);
    defer alloc.free(bytes);
    var restored = try decode(alloc, bytes, bytes.len);
    errdefer restored.deinit();
    const after = try encode(alloc, &restored, bytes.len);
    defer alloc.free(after);
    try std.testing.expectEqualSlices(u8, bytes, after);
    return restored;
}

test "apc snapshot every cut and scalar bulk continuation" {
    const testing = std.testing;
    const alloc = testing.allocator;
    for ([_][]const u8{
        "Ga=q,i=42,f=32,s=1,v=1;AAAAAA==",
        "Ga=p,i=42,z=-2147483648,H=2147483647",
        "Gabcdefghijklm=42;AAAA",
        "Ga=123456789012;AAAA",
        "Ga=q,a=t,!=5,A=4294967295;AA==",
        "25a1;s",
        "25a1;q;cp=E000",
        "Xprivate\x00payload",
    }) |sequence| {
        for ([_]bool{ false, true }) |bulk| {
            for (0..sequence.len + 1) |cut| {
                var source: apc.Handler = .{ .unknown_max_bytes = 128 };
                defer source.deinit();
                source.start();
                source.feedSlice(alloc, sequence[0..cut]);
                var restored = try roundtrip(&source);
                defer restored.deinit();
                if (bulk) {
                    source.feedSlice(alloc, sequence[cut..]);
                    restored.feedSlice(alloc, sequence[cut..]);
                } else for (sequence[cut..]) |byte| {
                    source.feed(alloc, byte);
                    restored.feed(alloc, byte);
                }
                var a = source.end();
                defer if (a) |*c| c.deinit(alloc);
                var b = restored.end();
                defer if (b) |*c| c.deinit(alloc);
                try testing.expectEqual(a == null, b == null);
                if (a) |value| try testing.expectEqualDeep(value, b.?);
            }
        }
    }
}

test "apc snapshot failed capture and captured versus future policy" {
    const testing = std.testing;
    const alloc = testing.allocator;
    for ([_][]const u8{ "G;AAAA", "25a1;q;cp=E000", "Xprivate" }) |sequence| {
        var source: apc.Handler = .{ .unknown_max_bytes = 32 };
        defer source.deinit();
        source.start();
        source.feedSlice(testing.failing_allocator, sequence);
        source.unknown_max_bytes = 1;
        source.max_bytes = .{};
        source.max_bytes.put(.kitty, 0);
        source.enable(.kitty, false);
        var restored = try roundtrip(&source);
        defer restored.deinit();
        if (sequence[0] == 'X') {
            try testing.expect(restored.state.unknown.truncated);
            try testing.expectEqual(@as(usize, 32), restored.state.unknown.max_bytes);
        } else try testing.expect(restored.state == .ignore);
        try testing.expectEqual(@as(?usize, 0), restored.max_bytes.get(.kitty));
        try testing.expect(restored.max_bytes.get(.glyph) == null);
        try testing.expect(!restored.enabled.contains(.kitty));
        restored.feedSlice(alloc, "tail");
        var command = restored.end();
        defer if (command) |*c| c.deinit(alloc);
        if (sequence[0] != 'X') try testing.expect(command == null);
    }
}

fn decodeWithAllocator(alloc: Allocator, bytes: []const u8) !void {
    var h = try decode(alloc, bytes, bytes.len);
    defer h.deinit();
}

test "apc snapshot unknown truncation resumes after allocation failure" {
    const testing = std.testing;
    const alloc = testing.allocator;
    var failing = testing.FailingAllocator.init(alloc, .{});
    var source: apc.Handler = .{ .unknown_max_bytes = 8 };
    defer source.deinit();
    source.start();
    source.feedSlice(failing.allocator(), "Xab");
    failing.fail_index = failing.alloc_index;
    failing.resize_fail_index = failing.resize_index;
    source.feedSlice(failing.allocator(), "cdef");
    try testing.expect(source.state.unknown.truncated);
    try testing.expectEqualStrings("Xab", source.state.unknown.data.items);
    source.unknown_max_bytes = 0;
    var restored = try roundtrip(&source);
    defer restored.deinit();
    failing.fail_index = std.math.maxInt(usize);
    failing.resize_fail_index = std.math.maxInt(usize);
    source.feedSlice(failing.allocator(), "123456789");
    restored.feedSlice(alloc, "123456789");
    var a = source.end().?;
    defer a.deinit(failing.allocator());
    var b = restored.end().?;
    defer b.deinit(alloc);
    try testing.expectEqualStrings("Xab12345", b.unknown.content);
    try testing.expect(b.unknown.truncated);
    try testing.expectEqualDeep(a, b);
}

test "apc snapshot captured limits survive policy changes and source destruction" {
    const testing = std.testing;
    const alloc = testing.allocator;
    for ([_][]const u8{ "G;AAAA", "25a1;s", "Xabcd" }) |sequence| {
        for ([_]usize{ 0, 1, 4, 5 }) |limit| {
            var source: apc.Handler = .{ .unknown_max_bytes = limit, .max_bytes = .initFull(limit) };
            source.start();
            source.feedSlice(alloc, sequence);
            source.max_bytes = .initFull(999);
            source.enabled = .{};
            var restored = try roundtrip(&source);
            defer restored.deinit();
            source.deinit();
            var repeated = try roundtrip(&restored);
            defer repeated.deinit();
            restored.feedSlice(alloc, "A");
            repeated.feed(alloc, 'A');
            var a = restored.end();
            defer if (a) |*c| c.deinit(alloc);
            var b = repeated.end();
            defer if (b) |*c| c.deinit(alloc);
            try testing.expectEqual(a == null, b == null);
            if (a) |value| try testing.expectEqualDeep(value, b.?);
        }
    }
}

test "apc snapshot malformed records and allocation failures" {
    const testing = std.testing;
    const alloc = testing.allocator;
    for ([_][]const u8{ "G;aGVsbG8=", "25a1;q;cp=E000", "Xprivate" }) |sequence| {
        var source: apc.Handler = .{ .unknown_max_bytes = 128 };
        defer source.deinit();
        source.start();
        source.feedSlice(alloc, sequence);
        const bytes = try encode(alloc, &source, 4096);
        defer alloc.free(bytes);
        try testing.checkAllAllocationFailures(alloc, decodeWithAllocator, .{bytes});
        for (0..bytes.len) |cut| try testing.expectError(error.InvalidSnapshot, decode(testing.failing_allocator, bytes[0..cut], 4096));
        for ([_]usize{ 0, 6, 7, 8, 9, 10, 12, 13, 48, 63 }) |offset| {
            const old = bytes[offset];
            bytes[offset] = 255;
            try testing.expectError(error.InvalidSnapshot, decode(testing.failing_allocator, bytes, 4096));
            bytes[offset] = old;
        }
        try testing.expectError(error.LimitExceeded, decode(alloc, bytes, bytes.len - 1));
        try testing.expectError(error.LimitExceeded, encode(alloc, &source, bytes.len - 1));
    }
}

test "apc snapshot rejects protocols absent from this build" {
    const testing = std.testing;
    var source: apc.Handler = .{};
    defer source.deinit();
    const bytes = try encode(testing.allocator, &source, 4096);
    defer testing.allocator.free(bytes);
    if (!options.kitty_graphics) {
        bytes[6] = 4;
        try testing.expectError(error.InvalidSnapshot, decode(testing.failing_allocator, bytes, 4096));
    }
    if (!options.glyph_protocol) {
        bytes[6] = 5;
        try testing.expectError(error.InvalidSnapshot, decode(testing.failing_allocator, bytes, 4096));
    }
}
