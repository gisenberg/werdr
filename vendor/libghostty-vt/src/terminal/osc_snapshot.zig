//! Authoritative unfinished OSC capture. Payloads may contain private data.
//! Capture only at quiescent feed boundaries, never inside dispatch callbacks.
const std = @import("std");
const osc = @import("osc.zig");
const Allocator = std.mem.Allocator;
pub const Error = error{ InvalidSnapshot, LimitExceeded, OutOfMemory };
const magic = "OSCPS1";
const header_len = 33;

const View = struct {
    active: bool,
    allocator_enabled: bool,
    state: osc.Parser.State,
    backing: u8 = 0,
    configured: usize,
    effective: usize = 0,
    bytes: []const u8 = "",
};

fn validate(v: View) Error!void {
    if (!v.active and (v.state != .start or v.backing != 0)) return error.InvalidSnapshot;
    switch (v.backing) {
        0 => if (v.bytes.len != 0 or v.effective != 0) return error.InvalidSnapshot,
        1 => if (v.effective != osc.Parser.MAX_BUF or v.bytes.len > v.effective) return error.InvalidSnapshot,
        2 => {
            if (!v.allocator_enabled or v.bytes.len > v.effective) return error.InvalidSnapshot;
            switch (v.state) {
                .invalid, .@"52", .@"66", .@"72", .@"99", .@"5522" => {},
                else => return error.InvalidSnapshot,
            }
        },
        else => return error.InvalidSnapshot,
    }
    if (v.backing != 0) switch (v.state) {
        .start, .@"3", .@"30", .@"300", .@"6", .@"55", .@"552", .@"77" => return error.InvalidSnapshot,
        else => {},
    };
}

pub fn encode(alloc: Allocator, parser: *const osc.Parser, active: bool, limit: usize) Error![]u8 {
    if (active and parser.command != .invalid) return error.InvalidSnapshot;
    var v: View = .{
        .active = active,
        .allocator_enabled = parser.alloc != null,
        .state = if (active) parser.state else .start,
        .configured = parser.max_allocating_bytes,
    };
    if (active) {
        if (parser.capture) |*cap| {
            v.effective = cap.max_bytes;
            const writer = switch (cap.backing) {
                .fixed => |*writer| w: {
                    if (writer.buffer.len != osc.Parser.MAX_BUF) return error.InvalidSnapshot;
                    v.backing = 1;
                    break :w writer;
                },
                .allocating => |*writer| w: {
                    v.backing = 2;
                    break :w &writer.writer;
                },
            };
            if (cap.writer != writer or writer.end > writer.buffer.len) return error.InvalidSnapshot;
            v.bytes = writer.buffer[0..writer.end];
        }
    }
    try validate(v);
    const state_name = @tagName(v.state);
    const prefix_len = header_len + state_name.len;
    const len = std.math.add(usize, prefix_len, v.bytes.len) catch return error.LimitExceeded;
    if (len > limit) return error.LimitExceeded;
    const bytes = try alloc.alloc(u8, len);
    @memcpy(bytes[0..6], magic);
    bytes[6] = @as(u8, @intFromBool(v.active)) | (@as(u8, @intFromBool(v.allocator_enabled)) << 1);
    bytes[7] = @intCast(state_name.len);
    bytes[8] = v.backing;
    std.mem.writeInt(u64, bytes[9..17], v.configured, .little);
    std.mem.writeInt(u64, bytes[17..25], v.effective, .little);
    std.mem.writeInt(u64, bytes[25..33], v.bytes.len, .little);
    @memcpy(bytes[header_len..prefix_len], state_name);
    @memcpy(bytes[prefix_len..], v.bytes);
    return bytes;
}

fn preflight(bytes: []const u8, active: bool, limit: usize) Error!View {
    if (bytes.len > limit) return error.LimitExceeded;
    if (bytes.len < header_len or !std.mem.eql(u8, bytes[0..6], magic)) return error.InvalidSnapshot;
    if (bytes[6] & ~@as(u8, 3) != 0 or (bytes[6] & 1 != 0) != active) return error.InvalidSnapshot;
    const name_len: usize = bytes[7];
    if (name_len > bytes.len - header_len) return error.InvalidSnapshot;
    const len = std.math.cast(usize, std.mem.readInt(u64, bytes[25..33], .little)) orelse return error.InvalidSnapshot;
    if (len != bytes.len - header_len - name_len) return error.InvalidSnapshot;
    const v: View = .{
        .active = active,
        .allocator_enabled = bytes[6] & 2 != 0,
        .state = std.meta.stringToEnum(osc.Parser.State, bytes[header_len..][0..name_len]) orelse return error.InvalidSnapshot,
        .backing = bytes[8],
        .configured = std.math.cast(usize, std.mem.readInt(u64, bytes[9..17], .little)) orelse return error.InvalidSnapshot,
        .effective = std.math.cast(usize, std.mem.readInt(u64, bytes[17..25], .little)) orelse return error.InvalidSnapshot,
        .bytes = bytes[header_len + name_len ..],
    };
    try validate(v);
    return v;
}

/// Atomic in-place replacement after matching outer continuation reconstruction.
/// Input can alias existing capture memory. Never move the rebound parser.
/// Limit bounds encoded bytes, not allocator overhead or retained capacity.
pub fn restore(parser: *osc.Parser, alloc: Allocator, active: bool, bytes: []const u8, limit: usize) Error!void {
    if (active and parser.command != .invalid) return error.InvalidSnapshot;
    const v = try preflight(bytes, active, limit);
    var fixed: [osc.Parser.MAX_BUF]u8 = undefined;
    var allocating: std.Io.Writer.Allocating = .init(alloc);
    if (v.backing == 1) @memcpy(fixed[0..v.bytes.len], v.bytes);
    if (v.backing == 2) {
        allocating = try .initCapacity(alloc, v.bytes.len);
        @memcpy(allocating.writer.buffer[0..v.bytes.len], v.bytes);
        allocating.writer.end = v.bytes.len;
    }
    // Reset before changing allocator intent, because command cleanup uses it.
    parser.reset();
    parser.alloc = if (v.allocator_enabled) alloc else null;
    parser.max_allocating_bytes = v.configured;
    parser.state = v.state;
    switch (v.backing) {
        0 => {},
        1 => {
            @memcpy(parser.buffer[0..v.bytes.len], fixed[0..v.bytes.len]);
            parser.capture = .{ .backing = .{ .fixed = .fixed(&parser.buffer) }, .writer = undefined, .max_bytes = v.effective };
            const cap = &parser.capture.?;
            cap.backing.fixed.end = v.bytes.len;
            cap.writer = &cap.backing.fixed;
        },
        2 => {
            parser.capture = .{ .backing = .{ .allocating = allocating }, .writer = undefined, .max_bytes = v.effective };
            const cap = &parser.capture.?;
            cap.writer = &cap.backing.allocating.writer;
        },
        else => unreachable,
    }
}

fn copyTo(source: *const osc.Parser, destination: *osc.Parser, active: bool) !void {
    const alloc = std.testing.allocator;
    const bytes = try encode(alloc, source, active, 1 << 20);
    defer alloc.free(bytes);
    try restore(destination, alloc, active, bytes, bytes.len);
    const copied = try encode(alloc, destination, active, 1 << 20);
    defer alloc.free(copied);
    try std.testing.expectEqualSlices(u8, bytes, copied);
}

test "osc snapshot every cut fixed and allocating capture" {
    const testing = std.testing;
    for ([_][]const u8{ "2;private title", "52;c;aGVsbG8=", "72;t=a:i=42;text/plain", "5522;type=write:id=test" }) |sequence| {
        for (0..sequence.len + 1) |cut| {
            var source: osc.Parser = .init(testing.allocator);
            defer source.deinit();
            var destination: osc.Parser = .init(testing.allocator);
            defer destination.deinit();
            source.nextSlice(sequence[0..cut]);
            try copyTo(&source, &destination, true);
            source.nextSlice(sequence[cut..]);
            destination.nextSlice(sequence[cut..]);
            const a = source.end(7);
            const b = destination.end(7);
            try testing.expectEqual(a == null, b == null);
            if (a) |value| try testing.expectEqualDeep(value.*, b.?.*);
        }
    }
}

test "osc snapshot allocation fallback preserves fixed capacity and independent limits" {
    const testing = std.testing;
    var source: osc.Parser = .init(testing.failing_allocator);
    defer source.deinit();
    source.max_allocating_bytes = 10;
    source.nextSlice("52;c;");
    try testing.expect(source.capture.?.backing == .fixed);
    var destination: osc.Parser = .init(testing.allocator);
    defer destination.deinit();
    try copyTo(&source, &destination, true);
    try testing.expectEqual(@as(usize, 10), destination.max_allocating_bytes);
    try testing.expectEqual(osc.Parser.MAX_BUF, destination.capture.?.max_bytes);
    const suffix = [_]u8{'a'} ** (osc.Parser.MAX_BUF + 1);
    source.nextSlice(&suffix);
    destination.nextSlice(&suffix);
    try testing.expect(source.end(7) == null);
    try testing.expect(destination.end(7) == null);
    try testing.expect(destination.state == .invalid);
}

test "osc snapshot scalar and bulk growth failure remain invalid" {
    const testing = std.testing;
    for ([_]bool{ false, true }) |bulk| {
        var failing = testing.FailingAllocator.init(testing.allocator, .{});
        var source: osc.Parser = .init(failing.allocator());
        defer source.deinit();
        source.nextSlice("52;c;");
        const prefix = [_]u8{'a'} ** (osc.Parser.MAX_BUF - 4);
        source.nextSlice(&prefix);
        failing.fail_index = failing.alloc_index;
        failing.resize_fail_index = failing.resize_index;
        const suffix = "abcdefgh";
        if (bulk) source.nextSlice(suffix) else for (suffix) |byte| source.next(byte);
        try testing.expect(source.state == .invalid);
        var destination: osc.Parser = .init(testing.allocator);
        defer destination.deinit();
        try copyTo(&source, &destination, true);
        try testing.expect(destination.end(7) == null);
        destination.reset();
        destination.nextSlice("2;recovered");
        try testing.expectEqualStrings("recovered", destination.end(7).?.change_window_title);
    }
}

test "osc snapshot fixed terminator capacity zero allocating limit and source destruction" {
    const testing = std.testing;
    for ([_]usize{ osc.Parser.MAX_BUF - 1, osc.Parser.MAX_BUF }) |len| {
        var destination: osc.Parser = .init(testing.allocator);
        defer destination.deinit();
        {
            var source: osc.Parser = .init(testing.allocator);
            defer source.deinit();
            source.nextSlice("2;");
            const payload = [_]u8{'a'} ** osc.Parser.MAX_BUF;
            source.nextSlice(payload[0..len]);
            try copyTo(&source, &destination, true);
        }
        const result = destination.end(7);
        try testing.expectEqual(len < osc.Parser.MAX_BUF, result != null);
        if (result) |command| try testing.expectEqual(len, command.change_window_title.len);
    }
    var source: osc.Parser = .init(testing.allocator);
    defer source.deinit();
    source.max_allocating_bytes = 0;
    source.nextSlice("52;");
    var destination: osc.Parser = .init(testing.allocator);
    defer destination.deinit();
    try copyTo(&source, &destination, true);
    source.next('a');
    destination.next('a');
    try testing.expect(source.end(7) == null);
    try testing.expect(destination.end(7) == null);
}

fn restoreWithAllocator(alloc: Allocator, bytes: []const u8) !void {
    var destination: osc.Parser = .init(alloc);
    defer destination.deinit();
    destination.nextSlice("2;old");
    restore(&destination, alloc, true, bytes, bytes.len) catch |err| {
        try std.testing.expectEqualStrings("old", destination.end(7).?.change_window_title);
        return err;
    };
}

test "osc snapshot malformed bounds and allocation failures are atomic" {
    const testing = std.testing;
    const alloc = testing.allocator;
    var source: osc.Parser = .init(alloc);
    defer source.deinit();
    source.nextSlice("52;c;private");
    const bytes = try encode(alloc, &source, true, 4096);
    defer alloc.free(bytes);
    try testing.checkAllAllocationFailures(alloc, restoreWithAllocator, .{bytes});
    var destination: osc.Parser = .init(alloc);
    defer destination.deinit();
    for (0..bytes.len) |len| try testing.expectError(error.InvalidSnapshot, restore(&destination, testing.failing_allocator, true, bytes[0..len], 4096));
    for ([_]usize{ 0, 6, 7, 8, 25, 33 }) |offset| {
        const old = bytes[offset];
        bytes[offset] = 255;
        try testing.expectError(error.InvalidSnapshot, restore(&destination, testing.failing_allocator, true, bytes, 4096));
        bytes[offset] = old;
    }
    try testing.expectError(error.LimitExceeded, restore(&destination, testing.failing_allocator, true, bytes, bytes.len - 1));
    try testing.expectError(error.InvalidSnapshot, restore(&destination, testing.failing_allocator, false, bytes, 4096));
    std.mem.writeInt(u64, bytes[17..25], 0, .little);
    try testing.expectError(error.InvalidSnapshot, restore(&destination, testing.failing_allocator, true, bytes, 4096));
}

test "osc snapshot inactive cleanup and reentrant capture rejection" {
    const testing = std.testing;
    var source: osc.Parser = .init(null);
    defer source.deinit();
    source.max_allocating_bytes = 23;
    var destination: osc.Parser = .init(testing.allocator);
    defer destination.deinit();
    destination.nextSlice("4;1;?;2;?");
    try testing.expect(destination.end(7) != null);
    try testing.expectError(error.InvalidSnapshot, encode(testing.failing_allocator, &destination, true, 4096));
    try copyTo(&source, &destination, false);
    try testing.expect(destination.alloc == null);
    try testing.expect(destination.command == .invalid);
    try testing.expect(destination.capture == null);
    try testing.expectEqual(@as(usize, 23), destination.max_allocating_bytes);
}

test "osc snapshot replacement input may alias fixed or allocating capture" {
    const testing = std.testing;
    const alloc = testing.allocator;
    for ([_][]const u8{ "2;private", "52;c;aGVsbG8=" }) |sequence| {
        var source: osc.Parser = .init(alloc);
        defer source.deinit();
        source.nextSlice(sequence);
        const encoded = try encode(alloc, &source, true, 4096);
        defer alloc.free(encoded);
        for ([_][]const u8{ "2;", "52;" }) |prefix| {
            var destination: osc.Parser = .init(alloc);
            defer destination.deinit();
            destination.nextSlice(prefix);
            destination.nextSlice(encoded);
            const alias = destination.capture.?.trailing();
            try testing.expectEqualSlices(u8, encoded, alias);
            try restore(&destination, alloc, true, alias, 4096);
            const after = try encode(alloc, &destination, true, 4096);
            defer alloc.free(after);
            try testing.expectEqualSlices(u8, encoded, after);
        }
    }
}
