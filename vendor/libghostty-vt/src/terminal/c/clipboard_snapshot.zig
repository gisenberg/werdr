//! In-flight clipboard write state omitted by the core terminal codec.
const lib = @import("../lib.zig");
const terminal_c = @import("terminal.zig");
const clipboard = @import("../kitty/clipboard.zig");
const Result = @import("result.zig").Result;

fn mapError(err: clipboard.snapshot.Error) Result {
    return switch (err) {
        error.InvalidSnapshot => .invalid_value,
        error.LimitExceeded => .limit_exceeded,
        error.OutOfMemory => .out_of_memory,
    };
}

pub fn encode_alloc(
    terminal_: terminal_c.Terminal,
    allocator: ?*const lib.alloc.Allocator,
    limit: usize,
    out_ptr_: ?*?[*]u8,
    out_len_: ?*usize,
) callconv(lib.calling_conv) Result {
    const out_ptr = out_ptr_ orelse return .invalid_value;
    const out_len = out_len_ orelse return .invalid_value;
    out_ptr.* = null;
    out_len.* = 0;
    const terminal = terminal_ orelse return .invalid_value;
    const state = terminal.stream.handler.kitty_clipboard_write orelse return .success;
    const bytes = clipboard.snapshot.encode(lib.alloc.default(allocator), state, limit) catch |err| return mapError(err);
    out_ptr.* = bytes.ptr;
    out_len.* = bytes.len;
    return .success;
}

pub fn restore(
    terminal_: terminal_c.Terminal,
    input: ?[*]const u8,
    len: usize,
    limit: usize,
) callconv(lib.calling_conv) Result {
    const terminal = terminal_ orelse return .invalid_value;
    if (len > limit) return .limit_exceeded;
    if (len != 0 and input == null) return .invalid_value;
    const alloc = terminal.terminal.gpa();
    const replacement: ?*clipboard.WriteState = replacement: {
        if (len == 0) break :replacement null;
        var decoded = clipboard.snapshot.decode(alloc, input.?[0..len], limit) catch |err| return mapError(err);
        const owned = alloc.create(clipboard.WriteState) catch {
            decoded.deinit(alloc);
            return .out_of_memory;
        };
        owned.* = decoded;
        break :replacement owned;
    };
    // Only commit after complete validation and allocation. No replay, reply,
    // clipboard callback, or grant consumption occurs here.
    if (terminal.stream.handler.kitty_clipboard_write) |old| {
        old.deinit(alloc);
        alloc.destroy(old);
    }
    terminal.stream.handler.kitty_clipboard_write = replacement;
    return .success;
}

test "clipboard snapshot C replacement allocation failures preserve old state" {
    const std = @import("std");
    const testing = std.testing;
    var next = try clipboard.WriteState.init(testing.allocator, &.{ .op = .write, .id = "new" }, .{});
    defer next.deinit(testing.allocator);
    try next.data(testing.allocator, &.{ .op = .wdata, .mime = "text/plain" }, "SGV");
    const encoded = try clipboard.snapshot.encode(testing.allocator, &next, 4096);
    defer testing.allocator.free(encoded);
    var succeeded = false;
    for (0..64) |failure_offset| {
        var failing = testing.FailingAllocator.init(testing.allocator, .{});
        const zig_alloc = failing.allocator();
        const c_alloc: lib.alloc.Allocator = .fromZig(&zig_alloc);
        var terminal: terminal_c.Terminal = null;
        try testing.expectEqual(Result.success, terminal_c.new(&c_alloc, &terminal, 20, 4));
        defer terminal_c.free(terminal);
        const alloc = terminal.?.terminal.gpa();
        const old = try alloc.create(clipboard.WriteState);
        old.* = try clipboard.WriteState.init(alloc, &.{ .op = .write, .id = "old" }, .{});
        terminal.?.stream.handler.kitty_clipboard_write = old;
        failing.fail_index = failing.alloc_index + failure_offset;
        const result = restore(terminal, encoded.ptr, encoded.len, encoded.len);
        if (result == .success) {
            try testing.expectEqualStrings("new", terminal.?.stream.handler.kitty_clipboard_write.?.id);
            try testing.expect(failure_offset > 0);
            succeeded = true;
            break;
        }
        try testing.expectEqual(Result.out_of_memory, result);
        try testing.expect(terminal.?.stream.handler.kitty_clipboard_write == old);
        try testing.expectEqualStrings("old", old.id);
    }
    try testing.expect(succeeded);
}

test "clipboard snapshot C invalid arguments and absent state" {
    const testing = @import("std").testing;
    var terminal: terminal_c.Terminal = null;
    try testing.expectEqual(Result.success, terminal_c.new(&lib.alloc.test_allocator, &terminal, 20, 4));
    defer terminal_c.free(terminal);
    var output: ?[*]u8 = null;
    var len: usize = 99;
    try testing.expectEqual(Result.invalid_value, encode_alloc(null, null, 0, &output, &len));
    try testing.expectEqual(@as(usize, 0), len);
    try testing.expectEqual(Result.invalid_value, encode_alloc(terminal, null, 0, null, &len));
    try testing.expectEqual(Result.invalid_value, encode_alloc(terminal, null, 0, &output, null));
    try testing.expectEqual(Result.success, encode_alloc(terminal, null, 0, &output, &len));
    try testing.expect(output == null);
    try testing.expectEqual(@as(usize, 0), len);
    try testing.expectEqual(Result.invalid_value, restore(null, null, 0, 0));
    try testing.expectEqual(Result.invalid_value, restore(terminal, null, 1, 1));
    try testing.expectEqual(Result.limit_exceeded, restore(terminal, null, 1, 0));
    try testing.expectEqual(Result.success, restore(terminal, null, 0, 0));
}
