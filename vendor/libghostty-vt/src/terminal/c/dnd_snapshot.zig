//! Owned DND state omitted by the core codec. No native drag ownership transfer.
const lib = @import("../lib.zig");
const terminal_c = @import("terminal.zig");
const dnd = @import("../kitty/dnd.zig");
const Result = @import("result.zig").Result;

fn mapError(err: dnd.snapshot.Error) Result {
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
    const state = terminal.terminal.kitty_dnd orelse return .success;
    const bytes = dnd.snapshot.encode(lib.alloc.default(allocator), state, limit) catch |err| return mapError(err);
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
    const replacement = if (len == 0) null else dnd.snapshot.decode(alloc, input.?[0..len], limit) catch |err| return mapError(err);
    // Decode owns all data before committing. Never replay events or callbacks.
    if (terminal.terminal.kitty_dnd) |old| old.destroy(alloc);
    terminal.terminal.kitty_dnd = replacement;
    return .success;
}

test "dnd snapshot C allocation failures leave original state intact" {
    const std = @import("std");
    const testing = std.testing;
    const next = try testing.allocator.create(dnd.State);
    next.* = .{};
    defer next.destroy(testing.allocator);
    next.drop.client_id = 42;
    try next.drop.registered_mimes.appendSlice(testing.allocator, "text/plain");
    var output: std.Io.Writer.Allocating = .init(testing.allocator);
    defer output.deinit();
    try next.dragDrop(testing.allocator, &output.writer, .{
        .cell_x = 1,
        .cell_y = 2,
        .pixel_x = 3,
        .pixel_y = 4,
        .operations = .{ .copy = true },
    }, &.{.{ .mime = "text/plain", .data = "private\x00\xff" }});
    const encoded = try dnd.snapshot.encode(testing.allocator, next, 4096);
    defer testing.allocator.free(encoded);
    var succeeded = false;
    for (0..32) |offset| {
        var failing = testing.FailingAllocator.init(testing.allocator, .{});
        const zig_alloc = failing.allocator();
        const c_alloc: lib.alloc.Allocator = .fromZig(&zig_alloc);
        var terminal: terminal_c.Terminal = null;
        try testing.expectEqual(Result.success, terminal_c.new(&c_alloc, &terminal, 20, 4));
        defer terminal_c.free(terminal);
        const alloc = terminal.?.terminal.gpa();
        const old = try alloc.create(dnd.State);
        old.* = .{};
        old.drop.client_id = 7;
        terminal.?.terminal.kitty_dnd = old;
        failing.fail_index = failing.alloc_index + offset;
        const result = restore(terminal, encoded.ptr, encoded.len, 4096);
        if (result == .success) {
            try testing.expectEqual(@as(u32, 42), terminal.?.terminal.kitty_dnd.?.drop.client_id);
            try testing.expectEqualStrings("private\x00\xff", terminal.?.terminal.kitty_dnd.?.drop.items.?[0].data);
            try testing.expect(offset > 0);
            succeeded = true;
            break;
        }
        try testing.expectEqual(Result.out_of_memory, result);
        try testing.expect(terminal.?.terminal.kitty_dnd == old);
        try testing.expectEqual(@as(u32, 7), old.drop.client_id);
    }
    try testing.expect(succeeded);
}

test "dnd snapshot C invalid arguments and absent state" {
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
