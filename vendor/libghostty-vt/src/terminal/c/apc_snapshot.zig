//! Authoritative APC state at quiescent stream boundaries.
const lib = @import("../lib.zig");
const terminal_c = @import("terminal.zig");
const snapshot = @import("../apc_snapshot.zig");
const Result = @import("result.zig").Result;

fn mapError(err: snapshot.Error) Result {
    return switch (err) {
        error.InvalidSnapshot => .invalid_value,
        error.LimitExceeded => .limit_exceeded,
        error.OutOfMemory => .out_of_memory,
    };
}

pub fn encode_alloc(terminal_: terminal_c.Terminal, allocator: ?*const lib.alloc.Allocator, limit: usize, out_ptr_: ?*?[*]u8, out_len_: ?*usize) callconv(lib.calling_conv) Result {
    const out_ptr = out_ptr_ orelse return .invalid_value;
    const out_len = out_len_ orelse return .invalid_value;
    out_ptr.* = null;
    out_len.* = 0;
    const terminal = terminal_ orelse return .invalid_value;
    const h = &terminal.stream.handler.apc_handler;
    if ((terminal.stream.parser.state == .sos_pm_apc_string) != (h.state != .inactive)) return .invalid_value;
    const bytes = snapshot.encode(lib.alloc.default(allocator), h, limit) catch |err| return mapError(err);
    out_ptr.* = bytes.ptr;
    out_len.* = bytes.len;
    return .success;
}

pub fn restore(terminal_: terminal_c.Terminal, input: ?[*]const u8, len: usize, limit: usize) callconv(lib.calling_conv) Result {
    const terminal = terminal_ orelse return .invalid_value;
    if (len > limit) return .limit_exceeded;
    if (input == null) return .invalid_value;
    if ((terminal.stream.parser.state == .sos_pm_apc_string) != (terminal.stream.handler.apc_handler.state != .inactive)) return .invalid_value;
    var replacement = snapshot.decode(terminal.terminal.gpa(), input.?[0..len], limit) catch |err| return mapError(err);
    if ((terminal.stream.parser.state == .sos_pm_apc_string) != (replacement.state != .inactive)) {
        replacement.deinit();
        return .invalid_value;
    }
    const h = &terminal.stream.handler.apc_handler;
    h.deinit();
    h.* = replacement;
    return .success;
}

test "apc snapshot C outer mismatch and failed replacement are atomic" {
    const std = @import("std");
    const testing = std.testing;
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const zig_alloc = failing.allocator();
    const c_alloc: lib.alloc.Allocator = .fromZig(&zig_alloc);
    var source: terminal_c.Terminal = null;
    var destination: terminal_c.Terminal = null;
    try testing.expectEqual(Result.success, terminal_c.new(&lib.alloc.test_allocator, &source, 20, 4));
    defer terminal_c.free(source);
    try testing.expectEqual(Result.success, terminal_c.new(&c_alloc, &destination, 20, 4));
    defer terminal_c.free(destination);
    const prefix = "\x1b_Xprivate";
    source.?.stream.handler.apc_handler.unknown_max_bytes = 128;
    destination.?.stream.handler.apc_handler.unknown_max_bytes = 64;
    terminal_c.vt_write(source, prefix.ptr, prefix.len);
    const bytes = try snapshot.encode(testing.allocator, &source.?.stream.handler.apc_handler, 4096);
    defer testing.allocator.free(bytes);
    try testing.expectEqual(Result.invalid_value, restore(destination, bytes.ptr, bytes.len, 4096));
    const old_prefix = "\x1b_Xold";
    terminal_c.vt_write(destination, old_prefix.ptr, old_prefix.len);
    const before = try snapshot.encode(testing.allocator, &destination.?.stream.handler.apc_handler, 4096);
    defer testing.allocator.free(before);
    failing.fail_index = failing.alloc_index;
    try testing.expectEqual(Result.out_of_memory, restore(destination, bytes.ptr, bytes.len, 4096));
    const after = try snapshot.encode(testing.allocator, &destination.?.stream.handler.apc_handler, 4096);
    defer testing.allocator.free(after);
    try testing.expectEqualSlices(u8, before, after);
    failing.fail_index = std.math.maxInt(usize);
    // Input aliases destination-owned unknown capture backing.
    destination.?.stream.handler.apc_handler.state.unknown.data.clearRetainingCapacity();
    try destination.?.stream.handler.apc_handler.state.unknown.data.appendSlice(zig_alloc, bytes);
    const alias = destination.?.stream.handler.apc_handler.state.unknown.data.items;
    try testing.expectEqual(Result.success, restore(destination, alias.ptr, alias.len, 4096));
    const copied = try snapshot.encode(testing.allocator, &destination.?.stream.handler.apc_handler, 4096);
    defer testing.allocator.free(copied);
    try testing.expectEqualSlices(u8, bytes, copied);
    var inactive: @import("../apc.zig").Handler = .{};
    defer inactive.deinit();
    const inactive_bytes = try snapshot.encode(testing.allocator, &inactive, 4096);
    defer testing.allocator.free(inactive_bytes);
    try testing.expectEqual(Result.invalid_value, restore(destination, inactive_bytes.ptr, inactive_bytes.len, 4096));
}

test "apc snapshot C discarded query stays silent after healthy replay" {
    if (comptime !@import("terminal_options").kitty_graphics) return error.SkipZigTest;
    const std = @import("std");
    const testing = std.testing;
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const zig_alloc = failing.allocator();
    const c_alloc: lib.alloc.Allocator = .fromZig(&zig_alloc);
    var source: terminal_c.Terminal = null;
    var destination: terminal_c.Terminal = null;
    try testing.expectEqual(Result.success, terminal_c.new(&c_alloc, &source, 20, 4));
    defer terminal_c.free(source);
    try testing.expectEqual(Result.success, terminal_c.new(&lib.alloc.test_allocator, &destination, 20, 4));
    defer terminal_c.free(destination);
    const prefix = "\x1b_Ga=q,i=42,f=32,s=1,v=1;AAAAAA==";
    failing.fail_index = failing.alloc_index;
    terminal_c.vt_write(source, prefix.ptr, prefix.len);
    try testing.expect(source.?.stream.handler.apc_handler.state == .ignore);
    terminal_c.vt_write(destination, prefix.ptr, prefix.len);
    try testing.expect(destination.?.stream.handler.apc_handler.state == .kitty);
    const bytes = try snapshot.encode(testing.allocator, &source.?.stream.handler.apc_handler, 4096);
    defer testing.allocator.free(bytes);
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
    terminal_c.vt_write(destination, "\x1b\\", 2);
    try testing.expectEqual(@as(usize, 0), S.writes);
    terminal_c.vt_write(destination, prefix.ptr, prefix.len);
    terminal_c.vt_write(destination, "\x1b\\", 2);
    try testing.expect(S.writes > 0);
}
