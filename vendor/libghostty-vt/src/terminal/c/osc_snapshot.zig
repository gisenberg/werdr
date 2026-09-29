//! Quiescent OSC capture replacement, separate from outer parser continuation.
const lib = @import("../lib.zig");
const terminal_c = @import("terminal.zig");
const snapshot = @import("../osc_snapshot.zig");
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
    const parser = &terminal.stream.parser;
    const bytes = snapshot.encode(lib.alloc.default(allocator), &parser.osc_parser, parser.state == .osc_string, limit) catch |err| return mapError(err);
    out_ptr.* = bytes.ptr;
    out_len.* = bytes.len;
    return .success;
}

pub fn restore(terminal_: terminal_c.Terminal, input: ?[*]const u8, len: usize, limit: usize) callconv(lib.calling_conv) Result {
    const terminal = terminal_ orelse return .invalid_value;
    if (len > limit) return .limit_exceeded;
    if (input == null) return .invalid_value;
    const parser = &terminal.stream.parser;
    snapshot.restore(&parser.osc_parser, terminal.terminal.gpa(), parser.state == .osc_string, input.?[0..len], limit) catch |err| return mapError(err);
    return .success;
}

test "osc snapshot C mismatched outer state rejects without effects" {
    const testing = @import("std").testing;
    var source: terminal_c.Terminal = null;
    var destination: terminal_c.Terminal = null;
    try testing.expectEqual(Result.success, terminal_c.new(&lib.alloc.test_allocator, &source, 20, 4));
    defer terminal_c.free(source);
    try testing.expectEqual(Result.success, terminal_c.new(&lib.alloc.test_allocator, &destination, 20, 4));
    defer terminal_c.free(destination);
    const prefix = "\x1b]2;private";
    terminal_c.vt_write(source, prefix.ptr, prefix.len);
    const bytes = try snapshot.encode(testing.allocator, &source.?.stream.parser.osc_parser, true, 4096);
    defer testing.allocator.free(bytes);
    try testing.expectEqual(Result.invalid_value, restore(destination, bytes.ptr, bytes.len, 4096));
    terminal_c.vt_write(destination, prefix.ptr, prefix.len);
    try testing.expectEqual(Result.success, restore(destination, bytes.ptr, bytes.len, 4096));
    try testing.expectEqual(Result.invalid_value, restore(null, bytes.ptr, bytes.len, 4096));
    try testing.expectEqual(Result.invalid_value, restore(destination, null, 0, 4096));
    try testing.expectEqual(Result.limit_exceeded, restore(destination, bytes.ptr, bytes.len, bytes.len - 1));
}

test "osc snapshot C failed capture suppresses future DND registration" {
    const std = @import("std");
    const testing = std.testing;
    for ([_]bool{ false, true }) |growth_failure| {
        var failing = testing.FailingAllocator.init(testing.allocator, .{});
        const zig_alloc = failing.allocator();
        const c_alloc: lib.alloc.Allocator = .fromZig(&zig_alloc);
        var source: terminal_c.Terminal = null;
        var destination: terminal_c.Terminal = null;
        var control: terminal_c.Terminal = null;
        try testing.expectEqual(Result.success, terminal_c.new(&c_alloc, &source, 20, 4));
        defer terminal_c.free(source);
        try testing.expectEqual(Result.success, terminal_c.new(&lib.alloc.test_allocator, &destination, 20, 4));
        defer terminal_c.free(destination);
        try testing.expectEqual(Result.success, terminal_c.new(&lib.alloc.test_allocator, &control, 20, 4));
        defer terminal_c.free(control);
        const prefix = "\x1b]72;t=a:i=42;";
        if (!growth_failure) failing.fail_index = failing.alloc_index;
        terminal_c.vt_write(source, prefix.ptr, prefix.len);
        terminal_c.vt_write(destination, prefix.ptr, prefix.len);
        terminal_c.vt_write(control, prefix.ptr, prefix.len);
        const payload = [_]u8{'a'} ** 2200;
        if (growth_failure) {
            failing.fail_index = failing.alloc_index;
            failing.resize_fail_index = failing.resize_index;
            terminal_c.vt_write(source, &payload, payload.len);
            terminal_c.vt_write(destination, &payload, payload.len);
            terminal_c.vt_write(control, &payload, payload.len);
        }
        const bytes = try snapshot.encode(testing.allocator, &source.?.stream.parser.osc_parser, true, 4096);
        defer testing.allocator.free(bytes);
        try testing.expectEqual(Result.success, restore(destination, bytes.ptr, bytes.len, 4096));
        if (!growth_failure) {
            terminal_c.vt_write(source, &payload, payload.len);
            terminal_c.vt_write(destination, &payload, payload.len);
            terminal_c.vt_write(control, &payload, payload.len);
        }
        for ([_]terminal_c.Terminal{ source, destination, control }) |t| terminal_c.vt_write(t, "\x07", 1);
        try testing.expect(source.?.terminal.kitty_dnd == null);
        try testing.expect(destination.?.terminal.kitty_dnd == null);
        try testing.expect(control.?.terminal.kitty_dnd != null);
        try testing.expectEqual(@as(u32, 42), control.?.terminal.kitty_dnd.?.drop.client_id);
    }
}
