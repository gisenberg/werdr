//! Sensitive handler state omitted by core snapshots. No callbacks are replayed.
const std = @import("std");
const lib = @import("../lib.zig");
const terminal_c = @import("terminal.zig");
const dcs = @import("../dcs.zig");
const Grants = @import("../kitty/clipboard_grants.zig").Grants;
const GrantEntry = @typeInfo(@TypeOf(@as(Grants, undefined).entries.items)).pointer.child;
const Result = @import("result.zig").Result;
const Error = dcs.snapshot.Error;
const magic = "HNDLR1";
const max_grants = 32;
const max_name = 128;
const max_password = 128;

fn mapError(err: Error) Result {
    return switch (err) {
        error.InvalidSnapshot => .invalid_value,
        error.LimitExceeded => .limit_exceeded,
        error.OutOfMemory => .out_of_memory,
    };
}

fn capture(alloc: std.mem.Allocator, terminal: terminal_c.Terminal, limit: usize) Error![]u8 {
    const h = &terminal.?.stream.handler;
    const name = h.terminfo_name orelse "";
    const entries = h.kitty_clipboard_grants.entries.items;
    if (name.len > max_name or entries.len > max_grants) return error.InvalidSnapshot;
    var prefix_len: usize = 17 + name.len;
    var backing: usize = entries.len * @sizeOf(GrantEntry);
    for (entries, 0..) |entry, i| {
        if (entry.pw.len == 0 or entry.pw.len > max_password) return error.InvalidSnapshot;
        for (entries[0..i]) |old| if (std.mem.eql(u8, old.pw, entry.pw)) return error.InvalidSnapshot;
        prefix_len += 2 + entry.pw.len;
        backing += entry.pw.len;
    }
    const overhead = @max(prefix_len, backing);
    if (overhead > limit) return error.LimitExceeded;
    const command = try dcs.snapshot.encode(alloc, &h.dcs_handler, limit - overhead);
    defer alloc.free(command);
    const bytes = try alloc.alloc(u8, prefix_len + command.len);
    @memcpy(bytes[0..6], magic);
    bytes[6] = @as(u8, @intFromBool(h.semantic_failure)) |
        (@as(u8, @intFromBool(h.title_report)) << 1) |
        (@as(u8, @intFromBool(h.terminfo_name != null)) << 2);
    std.mem.writeInt(u64, bytes[7..15], h.kitty_clipboard_write_max_bytes, .little);
    bytes[15] = @intCast(name.len);
    @memcpy(bytes[16..][0..name.len], name);
    var offset = 16 + name.len;
    bytes[offset] = @intCast(entries.len);
    offset += 1;
    for (entries) |entry| {
        bytes[offset] = @intCast(entry.pw.len);
        bytes[offset + 1] = @as(u8, @intFromBool(entry.read)) |
            (@as(u8, @intFromBool(entry.write)) << 1) |
            (@as(u8, @intFromBool(entry.one_time)) << 2);
        offset += 2;
        @memcpy(bytes[offset..][0..entry.pw.len], entry.pw);
        offset += entry.pw.len;
    }
    @memcpy(bytes[offset..], command);
    return bytes;
}

const GrantView = struct { pw: []const u8, flags: u8 };
const View = struct {
    flags: u8,
    max_write: usize,
    name: []const u8,
    grants: [max_grants]GrantView = undefined,
    count: usize,
    dcs_bytes: []const u8,
};

fn preflight(bytes: []const u8, limit: usize) Error!View {
    if (bytes.len > limit) return error.LimitExceeded;
    if (bytes.len < 17 or !std.mem.eql(u8, bytes[0..6], magic)) return error.InvalidSnapshot;
    const flags = bytes[6];
    const name_len: usize = bytes[15];
    if (flags & ~@as(u8, 7) != 0 or name_len > max_name or name_len > bytes.len - 17) return error.InvalidSnapshot;
    if (flags & 4 == 0 and name_len != 0) return error.InvalidSnapshot;
    var offset = 16 + name_len;
    const count: usize = bytes[offset];
    if (count > max_grants) return error.InvalidSnapshot;
    offset += 1;
    var v: View = .{
        .flags = flags,
        .max_write = std.math.cast(usize, std.mem.readInt(u64, bytes[7..15], .little)) orelse return error.InvalidSnapshot,
        .name = bytes[16..][0..name_len],
        .count = count,
        .dcs_bytes = "",
    };
    var backing = count * @sizeOf(GrantEntry);
    for (v.grants[0..count], 0..) |*entry, i| {
        if (bytes.len - offset < 2) return error.InvalidSnapshot;
        const len: usize = bytes[offset];
        const grant_flags = bytes[offset + 1];
        offset += 2;
        if (len == 0 or len > max_password or len > bytes.len - offset or grant_flags & ~@as(u8, 7) != 0) return error.InvalidSnapshot;
        entry.* = .{ .pw = bytes[offset..][0..len], .flags = grant_flags };
        for (v.grants[0..i]) |old| if (std.mem.eql(u8, old.pw, entry.pw)) return error.InvalidSnapshot;
        backing += len;
        offset += len;
    }
    v.dcs_bytes = bytes[offset..];
    // Include the nested DCS header conservatively in the backing budget.
    if (backing > limit or v.dcs_bytes.len > limit - backing) return error.LimitExceeded;
    return v;
}

pub fn encode_alloc(
    terminal: terminal_c.Terminal,
    allocator: ?*const lib.alloc.Allocator,
    limit: usize,
    out_ptr_: ?*?[*]u8,
    out_len_: ?*usize,
) callconv(lib.calling_conv) Result {
    const out_ptr = out_ptr_ orelse return .invalid_value;
    const out_len = out_len_ orelse return .invalid_value;
    out_ptr.* = null;
    out_len.* = 0;
    if (terminal == null) return .invalid_value;
    const bytes = capture(lib.alloc.default(allocator), terminal, limit) catch |err| return mapError(err);
    out_ptr.* = bytes.ptr;
    out_len.* = bytes.len;
    return .success;
}

fn replace(terminal: terminal_c.Terminal, bytes: []const u8, limit: usize) Error!void {
    const v = try preflight(bytes, limit);
    const wrapper = terminal.?;
    const alloc = wrapper.terminal.gpa();
    var next_dcs = try dcs.snapshot.decode(alloc, v.dcs_bytes, limit);
    errdefer next_dcs.deinit();
    if (next_dcs.state != .inactive and wrapper.stream.parser.state != .dcs_passthrough) return error.InvalidSnapshot;
    var next_grants: Grants = .{};
    errdefer next_grants.deinit(alloc);
    // Copy borrowed metadata before releasing any possible aliased source data.
    var name: [max_name]u8 = undefined;
    @memcpy(name[0..v.name.len], v.name);
    try next_grants.entries.ensureTotalCapacityPrecise(alloc, v.count);
    for (v.grants[0..v.count]) |entry| {
        const owned = try alloc.dupe(u8, entry.pw);
        next_grants.entries.appendAssumeCapacity(.{
            .pw = owned,
            .read = entry.flags & 1 != 0,
            .write = entry.flags & 2 != 0,
            .one_time = entry.flags & 4 != 0,
        });
    }
    const h = &wrapper.stream.handler;
    // All validation and allocation precede this no-fail commit. Do not unhook.
    h.dcs_handler.deinit();
    h.kitty_clipboard_grants.deinit(alloc);
    h.dcs_handler = next_dcs;
    h.kitty_clipboard_grants = next_grants;
    h.semantic_failure = v.flags & 1 != 0;
    h.title_report = v.flags & 2 != 0;
    h.kitty_clipboard_write_max_bytes = v.max_write;
    @memcpy(wrapper.terminfo_name_buf[0..v.name.len], name[0..v.name.len]);
    h.terminfo_name = if (v.flags & 4 != 0) wrapper.terminfo_name_buf[0..v.name.len] else null;
}

pub fn restore(terminal: terminal_c.Terminal, input: ?[*]const u8, len: usize, limit: usize) callconv(lib.calling_conv) Result {
    if (terminal == null) return .invalid_value;
    if (len > limit) return .limit_exceeded;
    if (input == null) return .invalid_value;
    replace(terminal, input.?[0..len], limit) catch |err| return mapError(err);
    return .success;
}

fn testTerminal() !terminal_c.Terminal {
    var t: terminal_c.Terminal = null;
    try std.testing.expectEqual(Result.success, terminal_c.new(&lib.alloc.test_allocator, &t, 20, 4));
    return t;
}

fn feed(t: terminal_c.Terminal, bytes: []const u8) void {
    terminal_c.vt_write(t, bytes.ptr, bytes.len);
}

fn expectEquivalent(a: terminal_c.Terminal, b: terminal_c.Terminal) !void {
    const alloc = std.testing.allocator;
    const left = try capture(alloc, a, 1 << 20);
    defer alloc.free(left);
    const right = try capture(alloc, b, 1 << 20);
    defer alloc.free(right);
    try std.testing.expectEqualSlices(u8, left, right);
}

test "handler snapshot all replacement failures preserve old state" {
    const testing = std.testing;
    const alloc = testing.allocator;
    const source = try testTerminal();
    defer terminal_c.free(source);
    const h = &source.?.stream.handler;
    h.title_report = true;
    h.semantic_failure = true;
    h.terminfo_name = "custom\xff";
    h.kitty_clipboard_write_max_bytes = 17;
    try h.kitty_clipboard_grants.grant(alloc, "secret\xff", .read, true);
    try h.kitty_clipboard_grants.grant(alloc, "other", .write, false);
    feed(source, "\x1bP+q544e");
    const bytes = try capture(alloc, source, 4096);
    defer alloc.free(bytes);
    var succeeded = false;
    for (0..32) |offset| {
        var failing = testing.FailingAllocator.init(alloc, .{});
        const zig_alloc = failing.allocator();
        const c_alloc: lib.alloc.Allocator = .fromZig(&zig_alloc);
        var destination: terminal_c.Terminal = null;
        try testing.expectEqual(Result.success, terminal_c.new(&c_alloc, &destination, 20, 4));
        defer terminal_c.free(destination);
        const old = &destination.?.stream.handler;
        old.terminfo_name = "old";
        try old.kitty_clipboard_grants.grant(destination.?.terminal.gpa(), "old-password", .write, true);
        feed(destination, "\x1bP+q436f");
        const before = try capture(alloc, destination, 4096);
        defer alloc.free(before);
        failing.fail_index = failing.alloc_index + offset;
        const result = restore(destination, bytes.ptr, bytes.len, 4096);
        if (result == .success) {
            try expectEquivalent(source, destination);
            try testing.expect(old.terminfo_name.?.ptr == &destination.?.terminfo_name_buf);
            succeeded = true;
            break;
        }
        try testing.expectEqual(Result.out_of_memory, result);
        const after = try capture(alloc, destination, 4096);
        defer alloc.free(after);
        try testing.expectEqualSlices(u8, before, after);
    }
    try testing.expect(succeeded);
}

test "handler snapshot grants retain consumption and eviction order" {
    const testing = std.testing;
    const alloc = testing.allocator;
    const source = try testTerminal();
    defer terminal_c.free(source);
    const destination = try testTerminal();
    defer terminal_c.free(destination);
    const a = &source.?.stream.handler.kitty_clipboard_grants;
    const b = &destination.?.stream.handler.kitty_clipboard_grants;
    for (0..max_grants) |i| {
        var buf: [16]u8 = undefined;
        const pw = try std.fmt.bufPrint(&buf, "pw-{d}", .{i});
        try a.grant(alloc, pw, .read, i == 1);
    }
    const bytes = try capture(alloc, source, 4096);
    defer alloc.free(bytes);
    try testing.expectEqual(Result.success, restore(destination, bytes.ptr, bytes.len, 4096));
    // Short password records occupy more native entry storage than wire bytes.
    try testing.expectError(error.LimitExceeded, capture(testing.failing_allocator, source, bytes.len));
    try testing.expectEqual(Result.limit_exceeded, restore(destination, bytes.ptr, bytes.len, bytes.len));
    // Wrong direction still consumes one-time pw-1 and moves pw-31 into its slot.
    try testing.expect(!a.use(alloc, "pw-1", .write));
    try testing.expect(!b.use(alloc, "pw-1", .write));
    try testing.expectEqualStrings("pw-31", b.entries.items[1].pw);
    for ([_][]const u8{ "new", "evict" }) |pw| {
        try a.grant(alloc, pw, .write, false);
        try b.grant(alloc, pw, .write, false);
    }
    try testing.expectEqualStrings("pw-31", b.entries.items[0].pw);
    try expectEquivalent(source, destination);
    feed(source, "\x1bc");
    feed(destination, "\x1bc");
    try expectEquivalent(source, destination);
}

test "handler snapshot mismatched DCS and malformed records reject atomically" {
    const testing = std.testing;
    const alloc = testing.allocator;
    const source = try testTerminal();
    defer terminal_c.free(source);
    const destination = try testTerminal();
    defer terminal_c.free(destination);
    feed(source, "\x1bP+q544e");
    const bytes = try capture(alloc, source, 4096);
    defer alloc.free(bytes);
    const before = try capture(alloc, destination, 4096);
    defer alloc.free(before);
    try testing.expectEqual(Result.invalid_value, restore(destination, bytes.ptr, bytes.len, 4096));
    for (0..bytes.len) |cut| try testing.expectEqual(Result.invalid_value, restore(destination, bytes.ptr, cut, 4096));
    try testing.expectEqual(Result.limit_exceeded, restore(destination, bytes.ptr, bytes.len, bytes.len - 1));
    const after = try capture(alloc, destination, 4096);
    defer alloc.free(after);
    try testing.expectEqualSlices(u8, before, after);
    try testing.expectEqual(Result.invalid_value, restore(destination, null, 0, 4096));
    try testing.expectEqual(Result.invalid_value, restore(null, bytes.ptr, bytes.len, 4096));
}

test "handler snapshot DCS failure remains ignored after healthy replay" {
    const testing = std.testing;
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const zig_alloc = failing.allocator();
    const c_alloc: lib.alloc.Allocator = .fromZig(&zig_alloc);
    var source: terminal_c.Terminal = null;
    try testing.expectEqual(Result.success, terminal_c.new(&c_alloc, &source, 20, 4));
    defer terminal_c.free(source);
    failing.fail_index = failing.alloc_index;
    feed(source, "\x1bP+q436f");
    try testing.expect(source.?.stream.handler.dcs_handler.state == .ignore);
    try testing.expect(!source.?.stream.handler.semantic_failure);
    failing.fail_index = std.math.maxInt(usize);
    const bytes = try capture(testing.allocator, source, 4096);
    defer testing.allocator.free(bytes);
    const destination = try testTerminal();
    defer terminal_c.free(destination);
    feed(destination, "\x1bP+q436f");
    try testing.expect(destination.?.stream.handler.dcs_handler.state == .xtgettcap);
    const S = struct {
        var writes: usize = 0;
        fn write(_: terminal_c.Terminal, _: ?*anyopaque, _: [*]const u8, _: usize) callconv(lib.calling_conv) void {
            writes += 1;
        }
    };
    S.writes = 0;
    try testing.expectEqual(Result.success, terminal_c.set(destination, .write_pty, @ptrCast(&S.write)));
    try testing.expectEqual(Result.success, restore(destination, bytes.ptr, bytes.len, 4096));
    try testing.expectEqual(@as(usize, 0), S.writes);
    feed(destination, "\x1b\\");
    try testing.expectEqual(@as(usize, 0), S.writes);
    feed(destination, "\x1bP+q436f\x1b\\");
    try testing.expect(S.writes > 0);
}

test "handler snapshot nullable binary names bounds and grant validation" {
    const testing = std.testing;
    const alloc = testing.allocator;
    const source = try testTerminal();
    defer terminal_c.free(source);
    const destination = try testTerminal();
    defer terminal_c.free(destination);
    const full_name = [_]u8{255} ** max_name;
    for ([_]?[]const u8{ null, "", "custom", &full_name }) |name| {
        source.?.stream.handler.terminfo_name = name;
        const bytes = try capture(alloc, source, 4096);
        defer alloc.free(bytes);
        try testing.expectEqual(Result.success, restore(destination, bytes.ptr, bytes.len, 4096));
        try expectEquivalent(source, destination);
        try testing.expectError(error.LimitExceeded, capture(testing.failing_allocator, source, bytes.len - 1));
    }
    source.?.stream.handler.terminfo_name = null;
    const grants = &source.?.stream.handler.kitty_clipboard_grants;
    try grants.grant(alloc, "aa", .read, false);
    try grants.grant(alloc, "bb", .write, true);
    const bytes = try capture(alloc, source, 4096);
    defer alloc.free(bytes);
    for ([_]usize{ 0, 6, 15, 16, 17, 18 }) |offset| {
        const old = bytes[offset];
        bytes[offset] = 255;
        try testing.expectEqual(Result.invalid_value, restore(destination, bytes.ptr, bytes.len, 4096));
        bytes[offset] = old;
    }
    @memcpy(bytes[23..25], "aa"); // Duplicate the first password.
    try testing.expectEqual(Result.invalid_value, restore(destination, bytes.ptr, bytes.len, 4096));
}
