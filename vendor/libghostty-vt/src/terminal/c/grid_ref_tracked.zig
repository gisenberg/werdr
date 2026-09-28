const std = @import("std");
const testing = std.testing;
const lib = @import("../lib.zig");
const PageList = @import("../PageList.zig");
const point = @import("../point.zig");
const grid_ref_c = @import("grid_ref.zig");
const terminal_c = @import("terminal.zig");
const Result = @import("result.zig").Result;

/// C: GhosttyTrackedGridRef
///
/// An owned tracked reference to a position in the terminal grid. The
/// underlying PageList pin is automatically updated as the PageList changes.
pub const CTrackedGridRef = ?*TrackedGridRef;

pub const TrackedGridRef = struct {
    alloc: std.mem.Allocator,
    // A detached reference may outlive both decoder and terminal.
    decode_budget: ?*@import("../snapshot/main.zig").Budget = null,
    terminal: terminal_c.Terminal,
    screen_key: terminal_c.TerminalScreen,
    screen_generation: usize,
    pin: *PageList.Pin,

    /// Return the PageList that owns this tracked ref's pin, or null if the
    /// owning screen has been removed/reinitialized since the ref was created.
    fn pageList(ref: *const TrackedGridRef) ?*PageList {
        const wrapper = ref.terminal orelse return null;
        const t = wrapper.terminal;
        if (t.screens.generation(ref.screen_key) != ref.screen_generation) return null;
        const screen = t.screens.get(ref.screen_key) orelse return null;
        return &screen.pages;
    }
};

pub fn tracked_grid_ref_free(ref_: CTrackedGridRef) callconv(lib.calling_conv) void {
    const ref = ref_ orelse return;
    if (ref.terminal) |wrapper| {
        _ = wrapper.tracked_grid_refs.swapRemove(ref);
    }
    if (ref.pageList()) |list| list.untrackPin(ref.pin);
    const budget = ref.decode_budget;
    ref.alloc.destroy(ref);
    if (budget) |owner| owner.release();
}

pub fn tracked_grid_ref_has_value(ref_: CTrackedGridRef) callconv(lib.calling_conv) bool {
    const ref = ref_ orelse return false;
    _ = ref.pageList() orelse return false;
    return !ref.pin.garbage;
}

pub fn tracked_grid_ref_snapshot(
    ref_: CTrackedGridRef,
    out_ref: ?*grid_ref_c.CGridRef,
) callconv(lib.calling_conv) Result {
    const ref = ref_ orelse return .invalid_value;
    _ = ref.pageList() orelse return .no_value;
    if (ref.pin.garbage) return .no_value;
    if (out_ref) |out| out.* = grid_ref_c.CGridRef.fromPin(ref.pin.*);
    return .success;
}

pub fn tracked_grid_ref_point(
    ref_: CTrackedGridRef,
    tag: point.Tag,
    out: ?*point.Coordinate,
) callconv(lib.calling_conv) Result {
    const ref = ref_ orelse return .invalid_value;
    const list = ref.pageList() orelse return .no_value;
    if (ref.pin.garbage) return .no_value;
    const pt = list.pointFromPin(tag, ref.pin.*) orelse return .no_value;
    if (out) |o| o.* = pt.coord();
    return .success;
}

pub fn tracked_grid_ref_set(
    ref_: CTrackedGridRef,
    terminal_: terminal_c.Terminal,
    pt: point.Point.C,
) callconv(lib.calling_conv) Result {
    const ref = ref_ orelse return .invalid_value;
    const wrapper = terminal_ orelse return .invalid_value;
    if (ref.terminal != terminal_) return .invalid_value;

    const t = wrapper.terminal;
    const list = &t.screens.active.pages;
    const p = list.pin(point.Point.fromC(pt)) orelse return .invalid_value;
    const tracked_pin = list.trackPin(p) catch return .out_of_memory;

    if (ref.pageList()) |old_list| old_list.untrackPin(ref.pin);
    ref.screen_key = t.screens.active_key;
    ref.screen_generation = t.screens.generation(ref.screen_key);
    ref.pin = tracked_pin;
    return .success;
}

/// Export a stable coordinate without changing the active screen or viewport.
pub fn tracked_grid_ref_screen_point(
    ref_: CTrackedGridRef,
    out_screen: ?*terminal_c.TerminalScreen,
    out_point: ?*point.Coordinate,
) callconv(lib.calling_conv) Result {
    const ref = ref_ orelse return .invalid_value;
    const list = ref.pageList() orelse return .no_value;
    if (ref.pin.garbage) return .no_value;
    const pt = list.pointFromPin(.screen, ref.pin.*) orelse return .no_value;
    if (out_screen) |out| out.* = ref.screen_key;
    if (out_point) |out| out.* = pt.coord();
    return .success;
}

test "tracked observer snapshot explicit screen and mixed page widths" {
    var terminal: terminal_c.Terminal = null;
    try testing.expectEqual(Result.success, terminal_c.new(&lib.alloc.test_allocator, &terminal, 20, 4));
    defer terminal_c.free(terminal);
    const t = terminal.?.terminal;
    const list = &t.screens.active.pages;
    // Model a retained wide page while the current grid is narrower.
    // Restore the dimension before terminal destruction.
    list.cols = 8;
    defer list.cols = 20;
    var ref: CTrackedGridRef = null;
    try testing.expectEqual(Result.success, terminal_c.grid_ref_track_screen(
        terminal,
        0,
        point.Point.cval(.{ .screen = .{ .x = 13, .y = 0 } }),
        &ref,
    ));
    defer tracked_grid_ref_free(ref);
    var screen: terminal_c.TerminalScreen = undefined;
    var coord: point.Coordinate = undefined;
    try testing.expectEqual(Result.success, tracked_grid_ref_screen_point(ref, &screen, &coord));
    try testing.expectEqual(terminal_c.TerminalScreen.primary, screen);
    try testing.expectEqual(@as(u16, 13), coord.x);
    try testing.expectEqual(Result.success, tracked_grid_ref_screen_point(ref, null, null));
    var invalid: CTrackedGridRef = null;
    try testing.expectEqual(Result.invalid_value, terminal_c.grid_ref_track(
        terminal,
        point.Point.cval(.{ .screen = .{ .x = 13, .y = 0 } }),
        &invalid,
    ));
    for ([_]c_int{ -1, 1, 2 }) |key| {
        try testing.expectEqual(Result.invalid_value, terminal_c.grid_ref_track_screen(
            terminal,
            key,
            point.Point.cval(.{ .screen = .{} }),
            &invalid,
        ));
        try testing.expect(invalid == null);
    }
    try testing.expectEqual(Result.invalid_value, terminal_c.grid_ref_track_screen(
        terminal,
        0,
        point.Point.cval(.{ .screen = .{} }),
        null,
    ));
    try testing.expect(t.screens.get(.alternate) == null);
    try testing.expectEqual(terminal_c.TerminalScreen.primary, t.screens.active_key);
}

test "tracked observer snapshot removed screen generation and pruned pin" {
    var terminal: terminal_c.Terminal = null;
    try testing.expectEqual(Result.success, terminal_c.new(&lib.alloc.test_allocator, &terminal, 20, 4));
    defer terminal_c.free(terminal);
    terminal_c.vt_write(terminal, "\x1b[?1049h", 8);
    var ref: CTrackedGridRef = null;
    try testing.expectEqual(Result.success, terminal_c.grid_ref_track_screen(
        terminal,
        1,
        point.Point.cval(.{ .screen = .{} }),
        &ref,
    ));
    defer tracked_grid_ref_free(ref);
    const t = terminal.?.terminal;
    t.screens.switchTo(.primary);
    t.screens.remove(t.gpa(), .alternate);
    terminal_c.vt_write(terminal, "\x1b[?1049h", 8);
    try testing.expectEqual(Result.no_value, tracked_grid_ref_screen_point(ref, null, null));
    var valid: CTrackedGridRef = null;
    try testing.expectEqual(Result.success, terminal_c.grid_ref_track_screen(
        terminal,
        0,
        point.Point.cval(.{ .screen = .{} }),
        &valid,
    ));
    defer tracked_grid_ref_free(valid);
    // Garbage is the native state of a pruned reference.
    valid.?.pin.garbage = true;
    try testing.expectEqual(Result.no_value, tracked_grid_ref_screen_point(valid, null, null));
}

test "tracked_grid_ref snapshots after terminal scroll" {
    var terminal: terminal_c.Terminal = null;
    try testing.expectEqual(Result.success, terminal_c.new(
        &lib.alloc.test_allocator,
        &terminal,
        5,
        2,
    ));
    defer terminal_c.free(terminal);

    terminal_c.vt_write(terminal, "A", 1);

    var ref: CTrackedGridRef = null;
    try testing.expectEqual(Result.success, terminal_c.grid_ref_track(
        terminal,
        point.Point.cval(.{ .active = .{ .x = 0, .y = 0 } }),
        &ref,
    ));
    defer tracked_grid_ref_free(ref);

    terminal_c.vt_write(terminal, "\r\nB\r\nC", 6);
    try testing.expect(tracked_grid_ref_has_value(ref));

    var snapshot: grid_ref_c.CGridRef = undefined;
    try testing.expectEqual(Result.success, tracked_grid_ref_snapshot(ref, &snapshot));

    var buf: [1]u32 = undefined;
    var len: usize = undefined;
    try testing.expectEqual(Result.success, grid_ref_c.grid_ref_graphemes(&snapshot, &buf, buf.len, &len));
    try testing.expectEqual(@as(usize, 1), len);
    try testing.expectEqual(@as(u32, 'A'), buf[0]);
}

test "tracked_grid_ref reports no value after reset" {
    var terminal: terminal_c.Terminal = null;
    try testing.expectEqual(Result.success, terminal_c.new(
        &lib.alloc.test_allocator,
        &terminal,
        5,
        2,
    ));
    defer terminal_c.free(terminal);

    terminal_c.vt_write(terminal, "A", 1);

    var ref: CTrackedGridRef = null;
    try testing.expectEqual(Result.success, terminal_c.grid_ref_track(
        terminal,
        point.Point.cval(.{ .active = .{ .x = 0, .y = 0 } }),
        &ref,
    ));
    defer tracked_grid_ref_free(ref);

    terminal_c.reset(terminal);
    try testing.expect(!tracked_grid_ref_has_value(ref));

    var snapshot: grid_ref_c.CGridRef = undefined;
    try testing.expectEqual(Result.no_value, tracked_grid_ref_snapshot(ref, &snapshot));
}

test "tracked_grid_ref reports no value after alternate screen reset" {
    var terminal: terminal_c.Terminal = null;
    try testing.expectEqual(Result.success, terminal_c.new(
        &lib.alloc.test_allocator,
        &terminal,
        5,
        2,
    ));
    defer terminal_c.free(terminal);

    terminal_c.vt_write(terminal, "\x1b[?1049hA", 9);

    var ref: CTrackedGridRef = null;
    try testing.expectEqual(Result.success, terminal_c.grid_ref_track(
        terminal,
        point.Point.cval(.{ .active = .{ .x = 0, .y = 0 } }),
        &ref,
    ));
    defer tracked_grid_ref_free(ref);

    terminal_c.vt_write(terminal, "\x1bc", 2);
    try testing.expect(!tracked_grid_ref_has_value(ref));

    var snapshot: grid_ref_c.CGridRef = undefined;
    try testing.expectEqual(Result.no_value, tracked_grid_ref_snapshot(ref, &snapshot));

    var coord: point.Coordinate = undefined;
    try testing.expectEqual(Result.no_value, tracked_grid_ref_point(ref, .active, &coord));

    terminal_c.vt_write(terminal, "\x1b[?1049h", 8);
    try testing.expect(!tracked_grid_ref_has_value(ref));

    try testing.expectEqual(Result.success, tracked_grid_ref_set(
        ref,
        terminal,
        point.Point.cval(.{ .active = .{ .x = 0, .y = 0 } }),
    ));
    try testing.expect(tracked_grid_ref_has_value(ref));
    try testing.expectEqual(Result.success, tracked_grid_ref_snapshot(ref, &snapshot));
}

test "tracked_grid_ref reports no value after terminal free" {
    var terminal: terminal_c.Terminal = null;
    try testing.expectEqual(Result.success, terminal_c.new(
        &lib.alloc.test_allocator,
        &terminal,
        5,
        2,
    ));

    terminal_c.vt_write(terminal, "A", 1);

    var ref: CTrackedGridRef = null;
    try testing.expectEqual(Result.success, terminal_c.grid_ref_track(
        terminal,
        point.Point.cval(.{ .active = .{ .x = 0, .y = 0 } }),
        &ref,
    ));

    terminal_c.free(terminal);
    try testing.expect(!tracked_grid_ref_has_value(ref));

    var snapshot: grid_ref_c.CGridRef = undefined;
    try testing.expectEqual(Result.no_value, tracked_grid_ref_snapshot(ref, &snapshot));

    var coord: point.Coordinate = undefined;
    try testing.expectEqual(Result.no_value, tracked_grid_ref_point(ref, .active, &coord));

    try testing.expectEqual(Result.invalid_value, tracked_grid_ref_set(
        ref,
        terminal,
        point.Point.cval(.{ .active = .{ .x = 0, .y = 0 } }),
    ));

    tracked_grid_ref_free(ref);
}
