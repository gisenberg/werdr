//! Screen-qualified placement records, separate from graphics-map installation.
//! Capture and binding preserve physical rows, including garbage-pin coordinates.
//! Relative parents are already resolved keys, never re-selected by preference.
const std = @import("std");
const Terminal = @import("../Terminal.zig");
const Screen = @import("../Screen.zig");
const ScreenKey = @import("../ScreenSet.zig").Key;
const PageList = @import("../PageList.zig");
const Storage = @import("graphics_storage.zig").ImageStorage;
const Placement = Storage.Placement;
const Key = Storage.PlacementKey;
pub const Error = error{ InvalidSnapshot, OutOfMemory };
const magic = "PLCST1";
pub const encoded_len = 96;

pub const Parameters = struct {
    x_offset: u32 = 0,
    y_offset: u32 = 0,
    source_x: u32 = 0,
    source_y: u32 = 0,
    source_width: u32 = 0,
    source_height: u32 = 0,
    columns: u32 = 0,
    rows: u32 = 0,
    z: i32 = 0,
};
const parameter_fields = .{ "x_offset", "y_offset", "source_x", "source_y", "source_width", "source_height", "columns", "rows", "z" };

pub const Record = struct {
    screen: ScreenKey,
    key: Key,
    location: union(enum) {
        pin: struct { x: u32, y: u64, garbage: bool },
        virtual,
        relative: Placement.Relative,
    },
    parameters: Parameters = .{},

    /// Bind only against already reconstructed screens with identical rows.
    /// Does not create a missing alternate screen, mutate graphics maps, update
    /// counts, reap garbage, resolve parents or assign a generation.
    pub fn bind(self: Record, terminal: *Terminal) Error!Bound {
        const screen = terminal.screens.get(self.screen) orelse return error.InvalidSnapshot;
        var placement: Placement = .{ .location = .virtual };
        inline for (parameter_fields) |name| @field(placement, name) = @field(self.parameters, name);
        placement.location = switch (self.location) {
            .virtual => .virtual,
            .relative => |rel| .{ .relative = rel },
            .pin => |saved| pin: {
                var row = saved.y;
                var node = screen.pages.pages.first;
                while (node) |n| : (node = n.next) {
                    if (row >= n.rows()) {
                        row -= n.rows();
                        continue;
                    }
                    // Validate against this page, not list.cols: partial
                    // reflow may retain pages with a different native width.
                    if (saved.x >= n.cols()) return error.InvalidSnapshot;
                    const p: PageList.Pin = .{ .node = n, .x = @intCast(saved.x), .y = @intCast(row), .garbage = saved.garbage };
                    break :pin .{ .pin = try screen.pages.trackPin(p) };
                }
                return error.InvalidSnapshot;
            },
        };
        return .{ .screen = screen, .key = self.key, .placement = placement };
    }
};

/// Owns a newly tracked pin until transferred into the matching screen's
/// graphics storage. The screen must outlive this value. No image reference
/// counts belong to this domain object; the storage coordinator owns those.
pub const Bound = struct {
    screen: *Screen,
    key: Key,
    placement: Placement,

    pub fn deinit(self: *Bound) void {
        self.placement.deinit(self.screen);
        self.* = undefined;
    }
};

/// Caller must hold exclusive terminal access across capture or binding.
/// Opt-in capture scans tracked-pin membership and page bounds without relying
/// on slow-runtime-safety-only helpers or dereferencing a foreign page pointer.
pub fn capture(terminal: *const Terminal, screen_key: ScreenKey, key: Key, placement: Placement) Error!Record {
    comptime {
        std.debug.assert(@typeInfo(Placement).@"struct".fields.len == parameter_fields.len + 1);
        std.debug.assert(@typeInfo(Parameters).@"struct".fields.len == parameter_fields.len);
        std.debug.assert(@typeInfo(Placement.Relative).@"struct".fields.len == 3);
        std.debug.assert(@typeInfo(Key).@"struct".fields.len == 2);
        std.debug.assert(@typeInfo(Storage.PlacementId).@"struct".fields.len == 2);
    }
    const screen = terminal.screens.get(screen_key) orelse return error.InvalidSnapshot;
    var record: Record = .{ .screen = screen_key, .key = key, .location = .virtual };
    inline for (parameter_fields) |name| @field(record.parameters, name) = @field(placement, name);
    record.location = switch (placement.location) {
        .virtual => .virtual,
        .relative => |rel| .{ .relative = rel },
        .pin => |p| pin: {
            if (p == screen.pages.viewport_pin) return error.InvalidSnapshot;
            if (std.mem.indexOfScalar(*PageList.Pin, screen.pages.trackedPins(), p) == null) return error.InvalidSnapshot;
            var row: u64 = 0;
            var node = screen.pages.pages.first;
            while (node) |n| : (node = n.next) {
                if (p.node == n) {
                    if (p.x >= n.cols() or p.y >= n.rows()) return error.InvalidSnapshot;
                    break :pin .{ .pin = .{ .x = p.x, .y = std.math.add(u64, row, p.y) catch return error.InvalidSnapshot, .garbage = p.garbage } };
                }
                row = std.math.add(u64, row, n.rows()) catch return error.InvalidSnapshot;
            }
            return error.InvalidSnapshot;
        },
    };
    return record;
}

fn put(comptime T: type, bytes: []u8, offset: usize, value: T) void {
    std.mem.writeInt(T, bytes[offset..][0..@sizeOf(T)], value, .little);
}
fn get(comptime T: type, bytes: []const u8, offset: usize) T {
    return std.mem.readInt(T, bytes[offset..][0..@sizeOf(T)], .little);
}
fn putKey(bytes: []u8, offset: usize, key: Key) void {
    put(u32, bytes, offset, key.image_id);
    bytes[offset + 4] = switch (key.placement_id.tag) {
        .internal => 0,
        .external => 1,
    };
    put(u32, bytes, offset + 8, key.placement_id.id);
}
fn getKey(bytes: []const u8, offset: usize) Error!Key {
    if (bytes[offset + 4] > 1 or !std.mem.allEqual(u8, bytes[offset + 5 ..][0..3], 0)) return error.InvalidSnapshot;
    return .{ .image_id = get(u32, bytes, offset), .placement_id = .{ .tag = if (bytes[offset + 4] == 0) .internal else .external, .id = get(u32, bytes, offset + 8) } };
}

pub fn encode(record: Record) [encoded_len]u8 {
    var bytes: [encoded_len]u8 = @splat(0);
    @memcpy(bytes[0..magic.len], magic);
    bytes[6] = switch (record.screen) {
        .primary => 0,
        .alternate => 1,
    };
    putKey(&bytes, 8, record.key);
    switch (record.location) {
        .pin => |p| {
            bytes[7] = 0;
            put(u32, &bytes, 20, p.x);
            put(u64, &bytes, 24, p.y);
            bytes[32] = @intFromBool(p.garbage);
        },
        .virtual => bytes[7] = 1,
        .relative => |rel| {
            bytes[7] = 2;
            putKey(&bytes, 20, rel.parent);
            put(i32, &bytes, 32, rel.horizontal_offset);
            put(i32, &bytes, 36, rel.vertical_offset);
        },
    }
    inline for (parameter_fields, 0..) |name, i| put(@TypeOf(@field(record.parameters, name)), &bytes, 40 + 4 * i, @field(record.parameters, name));
    return bytes;
}

/// Pointer-free decoding does not validate parent existence or graph shape.
/// Native ancestor replacement can legitimately create over-depth chains; the
/// coordinator must preserve their future null resolution, not reject depth.
/// Internal ID wrap can also produce cycles with the same bounded resolution.
pub fn decode(bytes: []const u8) Error!Record {
    if (bytes.len != encoded_len or !std.mem.eql(u8, bytes[0..magic.len], magic) or
        bytes[6] > 1 or bytes[7] > 2 or !std.mem.allEqual(u8, bytes[76..], 0)) return error.InvalidSnapshot;
    var record: Record = .{ .screen = if (bytes[6] == 0) .primary else .alternate, .key = try getKey(bytes, 8), .location = .virtual };
    record.location = switch (bytes[7]) {
        0 => pin: {
            if (bytes[32] > 1 or !std.mem.allEqual(u8, bytes[33..40], 0)) return error.InvalidSnapshot;
            break :pin .{ .pin = .{ .x = get(u32, bytes, 20), .y = get(u64, bytes, 24), .garbage = bytes[32] == 1 } };
        },
        1 => virtual: {
            if (!std.mem.allEqual(u8, bytes[20..40], 0)) return error.InvalidSnapshot;
            break :virtual .virtual;
        },
        2 => .{ .relative = .{ .parent = try getKey(bytes, 20), .horizontal_offset = get(i32, bytes, 32), .vertical_offset = get(i32, bytes, 36) } },
        else => unreachable,
    };
    inline for (parameter_fields, 0..) |name, i| @field(record.parameters, name) = get(@TypeOf(@field(record.parameters, name)), bytes, 40 + 4 * i);
    return record;
}

const test_key: Key = .{ .image_id = 1, .placement_id = .{ .tag = .external, .id = 2 } };

test "placement snapshot exact values and malformed records" {
    const testing = std.testing;
    for ([_]ScreenKey{ .primary, .alternate }) |screen| {
        const records = [_]Record{
            .{ .screen = screen, .key = test_key, .location = .{ .pin = .{ .x = std.math.maxInt(u32), .y = std.math.maxInt(u64), .garbage = true } } },
            .{ .screen = screen, .key = test_key, .location = .virtual },
            .{ .screen = screen, .key = .{ .image_id = 8, .placement_id = .{ .tag = .internal, .id = 2 } }, .location = .{ .relative = .{ .parent = test_key, .horizontal_offset = std.math.minInt(i32), .vertical_offset = std.math.maxInt(i32) } } },
        };
        for (records) |original| {
            var record = original;
            record.parameters = .{ .x_offset = 1, .y_offset = 2, .source_x = 3, .source_y = 4, .source_width = 5, .source_height = 6, .columns = 7, .rows = std.math.maxInt(u32), .z = std.math.minInt(i32) };
            var bytes = encode(record);
            try testing.expectEqualDeep(record, try decode(&bytes));
            for (0..encoded_len) |len| try testing.expectError(error.InvalidSnapshot, decode(bytes[0..len]));
            const trailing = bytes ++ [_]u8{0};
            try testing.expectError(error.InvalidSnapshot, decode(&trailing));
            for ([_]usize{ 0, 6, 7, 12, 13, 76, 95 }) |offset| {
                const saved = bytes[offset];
                bytes[offset] = 255;
                try testing.expectError(error.InvalidSnapshot, decode(&bytes));
                bytes[offset] = saved;
            }
        }
    }
    var pin = encode(.{ .screen = .primary, .key = test_key, .location = .{ .pin = .{ .x = 1, .y = 1, .garbage = false } } });
    pin[32] = 2;
    try testing.expectError(error.InvalidSnapshot, decode(&pin));
    pin[32] = 0;
    pin[33] = 1;
    try testing.expectError(error.InvalidSnapshot, decode(&pin));
    var virtual = encode(.{ .screen = .primary, .key = test_key, .location = .virtual });
    virtual[20] = 1;
    try testing.expectError(error.InvalidSnapshot, decode(&virtual));
    var relative = encode(.{ .screen = .primary, .key = test_key, .location = .{ .relative = .{ .parent = test_key } } });
    relative[24] = 2;
    try testing.expectError(error.InvalidSnapshot, decode(&relative));
}

test "placement snapshot screen ownership and pin rejection" {
    const testing = std.testing;
    const alloc = testing.allocator;
    var t = try Terminal.init(testing.io, alloc, .{ .cols = 8, .rows = 4 });
    defer t.deinit(alloc);
    const primary = t.screens.active;
    const record: Record = .{ .screen = .alternate, .key = test_key, .location = .{ .pin = .{ .x = 3, .y = 2, .garbage = true } } };
    try testing.expectError(error.InvalidSnapshot, record.bind(&t));
    const alternate = try t.screens.getInit(testing.io, alloc, .alternate, .{ .cols = 8, .rows = 4 });
    // Alternate stays inactive throughout binding and capture.
    const before = alternate.pages.countTrackedPins();
    var bound = try record.bind(&t);
    try testing.expectEqual(primary, t.screens.active);
    try testing.expectEqualDeep(record, try capture(&t, .alternate, bound.key, bound.placement));
    try testing.expectError(error.InvalidSnapshot, capture(&t, .primary, bound.key, bound.placement));
    try testing.expectEqual(before + 1, alternate.pages.countTrackedPins());
    bound.deinit();
    try testing.expectEqual(before, alternate.pages.countTrackedPins());
    var untracked = primary.pages.pin(.{ .active = .{} }).?;
    try testing.expectError(error.InvalidSnapshot, capture(&t, .primary, test_key, .{ .location = .{ .pin = &untracked } }));
    try testing.expectError(error.InvalidSnapshot, capture(&t, .primary, test_key, .{ .location = .{ .pin = primary.pages.viewport_pin } }));
    var invalid = record;
    invalid.location.pin.x = 8;
    try testing.expectError(error.InvalidSnapshot, invalid.bind(&t));
    invalid = record;
    invalid.location.pin.y = std.math.maxInt(u64);
    try testing.expectError(error.InvalidSnapshot, invalid.bind(&t));
    try testing.expectEqual(before, alternate.pages.countTrackedPins());
}

test "placement snapshot mixed page widths and history" {
    const testing = std.testing;
    const alloc = testing.allocator;
    var t = try Terminal.init(testing.io, alloc, .{ .cols = 4, .rows = 2 });
    defer t.deinit(alloc);
    var builder = try PageList.Builder.init(alloc, .{ .cols = 4, .rows = 2, .max_size = null, .max_lines = null });
    defer builder.deinit();
    const wide = try builder.allocatePage(.{ .cols = 8, .rows = 2 });
    wide.size.rows = 2;
    const narrow = try builder.allocatePage(.{ .cols = 2, .rows = 2 });
    narrow.size.rows = 2;
    var mixed = try builder.finish();
    defer mixed.deinit();
    // Isolate page-coordinate operations; the terminal cursor remains owned by
    // its original page list, restored before terminal cleanup or operations.
    std.mem.swap(PageList, &mixed, &t.screens.active.pages);
    defer std.mem.swap(PageList, &mixed, &t.screens.active.pages);
    const record: Record = .{ .screen = .primary, .key = test_key, .location = .{ .pin = .{ .x = 7, .y = 1, .garbage = true } } };
    var bound = try record.bind(&t);
    defer bound.deinit();
    try testing.expectEqualDeep(record, try capture(&t, .primary, bound.key, bound.placement));
    var invalid = record;
    invalid.location.pin.y = 2;
    try testing.expectError(error.InvalidSnapshot, invalid.bind(&t));
    invalid.location.pin.x = 1;
    var valid = try invalid.bind(&t);
    defer valid.deinit();
    try testing.expectEqualDeep(invalid, try capture(&t, .primary, valid.key, valid.placement));
}

fn bindFailing(alloc: std.mem.Allocator) !void {
    var t = try Terminal.init(std.testing.io, alloc, .{ .cols = 8, .rows = 4 });
    defer t.deinit(alloc);
    const before = t.screens.active.pages.countTrackedPins();
    var owned: [128]?Bound = @splat(null);
    defer {
        for (&owned) |*entry| if (entry.*) |*bound| bound.deinit();
        std.debug.assert(before == t.screens.active.pages.countTrackedPins());
    }
    for (&owned) |*entry| entry.* = try (Record{ .screen = .primary, .key = test_key, .location = .{ .pin = .{ .x = 3, .y = 2, .garbage = false } } }).bind(&t);
}

test "placement snapshot binding allocation cleanup" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, bindFailing, .{});
}

test "placement snapshot garbage coordinates survive future reflow" {
    const testing = std.testing;
    const alloc = testing.allocator;
    var source = try Terminal.init(testing.io, alloc, .{ .cols = 8, .rows = 4 });
    defer source.deinit(alloc);
    var destination = try Terminal.init(testing.io, alloc, .{ .cols = 8, .rows = 4 });
    defer destination.deinit(alloc);
    const record: Record = .{ .screen = .primary, .key = test_key, .location = .{ .pin = .{ .x = 7, .y = 2, .garbage = true } } };
    var original = try record.bind(&source);
    defer original.deinit();
    const bytes = encode(try capture(&source, .primary, original.key, original.placement));
    var restored = try (try decode(&bytes)).bind(&destination);
    defer restored.deinit();
    for ([_]u16{ 3, 12, 5, 8 }) |cols| {
        try source.resize(alloc, .{ .cols = cols, .rows = 4 });
        try destination.resize(alloc, .{ .cols = cols, .rows = 4 });
        try testing.expectEqualDeep(try capture(&source, .primary, original.key, original.placement), try capture(&destination, .primary, restored.key, restored.placement));
        try testing.expect(restored.placement.location.pin.garbage);
        try testing.expectEqual(source.screens.active.pages.total_rows, destination.screens.active.pages.total_rows);
    }
}

fn runCommand(t: *Terminal, text: []const u8) !void {
    const command = @import("graphics_command.zig");
    const parsed = try command.Parser.parseString(std.testing.allocator, text);
    defer parsed.deinit(std.testing.allocator);
    const response = @import("graphics_exec.zig").execute(std.testing.io, std.testing.allocator, t, &parsed).?;
    try std.testing.expect(response.ok());
}

// Test only: replace each value directly so native addPlacement cannot reap,
// reselect parents, assign IDs or change counts during domain characterization.
fn roundtripPlacements(t: *Terminal) !void {
    const s = t.screens.active;
    var it = s.kitty_images.placements.iterator();
    while (it.next()) |entry| {
        const bytes = encode(try capture(t, t.screens.active_key, entry.key_ptr.*, entry.value_ptr.*));
        const bound = try (try decode(&bytes)).bind(t);
        entry.value_ptr.deinit(s);
        entry.value_ptr.* = bound.placement; // Ownership transfers to storage.
        const after = encode(try capture(t, t.screens.active_key, entry.key_ptr.*, entry.value_ptr.*));
        try std.testing.expectEqualSlices(u8, &bytes, &after);
    }
}

test "placement snapshot retains reachable over-depth relative chains" {
    const testing = std.testing;
    const alloc = testing.allocator;
    var t = try Terminal.init(testing.io, alloc, .{ .cols = 8, .rows = 4 });
    defer t.deinit(alloc);
    try runCommand(&t, "a=t,f=24,s=1,v=1,i=1;////");
    try runCommand(&t, "a=p,i=1,p=1,U=1");
    var buffer: [96]u8 = undefined;
    for (2..10) |id| {
        try runCommand(&t, try std.fmt.bufPrint(&buffer, "a=p,i=1,p={d},P=1,Q={d},H=1", .{ id, id - 1 }));
    }
    const storage = &t.screens.active.kitty_images;
    const leaf: Key = .{ .image_id = 1, .placement_id = .{ .tag = .external, .id = 9 } };
    try testing.expect(storage.resolveChain(storage.placements.get(leaf).?.location.relative) != null);
    try runCommand(&t, "a=p,i=1,p=10,U=1");
    try runCommand(&t, "a=p,i=1,p=1,P=1,Q=10");
    try testing.expect(storage.resolveChain(storage.placements.get(leaf).?.location.relative) == null);
    try roundtripPlacements(&t);
    try testing.expectEqual(@as(usize, 10), storage.placements.count());
    try testing.expect(storage.resolveChain(storage.placements.get(leaf).?.location.relative) == null);
    // Restoring an unresolved chain must not destroy its future recovery.
    try runCommand(&t, "a=p,i=1,p=1,U=1");
    try testing.expect(storage.resolveChain(storage.placements.get(leaf).?.location.relative) != null);
}

test "placement snapshot retains internal ID wrap cycle" {
    const testing = std.testing;
    const alloc = testing.allocator;
    var t = try Terminal.init(testing.io, alloc, .{ .cols = 8, .rows = 4 });
    defer t.deinit(alloc);
    try runCommand(&t, "a=t,f=24,s=1,v=1,i=1;////");
    try runCommand(&t, "a=p,i=1,U=1");
    const storage = &t.screens.active.kitty_images;
    storage.next_internal_placement_id = std.math.maxInt(u32);
    try runCommand(&t, "a=p,i=1,U=1");
    try testing.expectEqual(@as(u32, 0), storage.next_internal_placement_id);
    // Parent selection chooses existing internal zero. Anonymous-child
    // validation cannot see that the wrapped insertion replaces that parent.
    try runCommand(&t, "a=p,i=1,P=1");
    const key: Key = .{ .image_id = 1, .placement_id = .{ .tag = .internal, .id = 0 } };
    try testing.expect(storage.placements.get(key).?.location.relative.parent.eql(key));
    try testing.expect(storage.resolveChain(storage.placements.get(key).?.location.relative) == null);
    try roundtripPlacements(&t);
    try testing.expectEqual(@as(usize, 2), storage.placements.count());
    try testing.expect(storage.placements.get(key).?.location.relative.parent.eql(key));
    try testing.expect(storage.resolveChain(storage.placements.get(key).?.location.relative) == null);
}

test "placement snapshot garbage keeps lazy reaping and descendant removal" {
    const testing = std.testing;
    const alloc = testing.allocator;
    for ([_]bool{ false, true }) |restore| {
        var t = try Terminal.init(testing.io, alloc, .{ .cols = 8, .rows = 4 });
        defer t.deinit(alloc);
        try runCommand(&t, "a=t,f=24,s=1,v=1,i=1;////");
        try runCommand(&t, "a=p,i=1,p=1");
        try runCommand(&t, "a=p,i=1,p=2,P=1,Q=1");
        const storage = &t.screens.active.kitty_images;
        const root: Key = .{ .image_id = 1, .placement_id = .{ .tag = .external, .id = 1 } };
        storage.placements.get(root).?.location.pin.garbage = true;
        const tracked = t.screens.active.pages.countTrackedPins();
        if (restore) try roundtripPlacements(&t);
        try testing.expectEqual(@as(usize, 2), storage.placements.count());
        try testing.expectEqual(@as(u30, 2), storage.imageById(1).?.metadata.placement_count);
        try testing.expectEqual(tracked, t.screens.active.pages.countTrackedPins());
        try runCommand(&t, "a=p,i=1,p=3,U=1");
        try testing.expectEqual(@as(usize, 1), storage.placements.count());
        try testing.expectEqual(@as(u30, 1), storage.imageById(1).?.metadata.placement_count);
        try testing.expectEqual(tracked - 1, t.screens.active.pages.countTrackedPins());
    }
}
