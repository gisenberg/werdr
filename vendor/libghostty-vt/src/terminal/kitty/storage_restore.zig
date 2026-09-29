//! Owned graphics assembly for an unpublished, reconstructed terminal.
//! This is not a runtime handoff API. The coordinator must rebind generations,
//! clocks and external producers before publishing the destination terminal.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Terminal = @import("../Terminal.zig");
const Screen = @import("../Screen.zig");
const ScreenKey = @import("../ScreenSet.zig").Key;
const Storage = @import("graphics_storage.zig").ImageStorage;
const image = @import("graphics_image.zig");
const snapshots = @import("storage_snapshot.zig");
const images = @import("image_snapshot.zig");
const placements = @import("placement_snapshot.zig");
pub const Error = snapshots.Error || error{ InvalidPhase, AllocatorMismatch };
const keys = [_]ScreenKey{ .primary, .alternate };

/// Transfer this allocation to the host policy owner before publication.
/// It must outlive installed policy slices, until replacement or destruction.
/// ImageStorage does not free directory backing.
pub const PolicyBacking = struct {
    allocator: Allocator,
    bytes: []u8,

    pub fn deinit(self: *PolicyBacking) void {
        self.allocator.free(self.bytes);
        self.* = undefined;
    }
};

pub const Prepared = struct {
    // Coordinator access is limited to rebinding generation and clock fields.
    // Do not change map/record ownership, policy slices or allocator identity.
    allocator: Allocator,
    stores: [2]?Storage = .{ null, null },
    records: [2]std.ArrayListUnmanaged(placements.Record) = .{ .empty, .empty },
    policy: ?PolicyBacking = null,
    clock_cut: ?u64,
    installed: bool = false,

    pub fn deinit(self: *Prepared) void {
        for (&self.stores) |*slot| if (slot.*) |*s| {
            // Uninstalled stores never own bound placement pins.
            std.debug.assert(s.placements.count() == 0);
            s.placements.deinit(self.allocator);
            if (s.loading) |v| v.destroy(self.allocator);
            var it = s.images.valueIterator();
            while (it.next()) |img| img.deinit(self.allocator);
            s.images.deinit(self.allocator);
        };
        for (&self.records) |*records| records.deinit(self.allocator);
        if (self.policy) |*policy| policy.deinit();
        self.* = undefined;
    }

    /// Decode with the destination allocator and build maps without pinning or
    /// retaining any target screen. Hooks must have destination-host provenance.
    /// Limits cover the snapshot's logical backing, not transient map capacity.
    pub fn prepare(alloc: Allocator, bytes: []const u8, limits: snapshots.Limits, resolver: ?images.FileResolver, hooks: [2]?image.SnapshotFileHook) Error!Prepared {
        var snapshot = try snapshots.decode(alloc, bytes, limits, resolver);
        defer snapshot.deinit(alloc);
        var result: Prepared = .{ .allocator = alloc, .clock_cut = snapshot.clock_cut };
        errdefer result.deinit();
        var directory_bytes: usize = 0;
        for (snapshot.screens, 0..) |slot, i| if (slot) |s| {
            if (s.metadata.policy.snapshot_file and hooks[i] == null) return error.BackingUnavailable;
            if (s.metadata.policy.directory) |dir| directory_bytes = std.math.add(usize, directory_bytes, dir.len) catch return error.LimitExceeded;
        };
        const policy_bytes = try alloc.alloc(u8, directory_bytes);
        result.policy = .{ .allocator = alloc, .bytes = policy_bytes };
        var offset: usize = 0;
        for (&snapshot.screens, 0..) |*slot, i| if (slot.*) |*s| {
            const meta = s.metadata;
            const policy = meta.policy;
            var directory: ?[]const u8 = null;
            if (policy.directory) |dir| {
                const dest = result.policy.?.bytes[offset..][0..dir.len];
                @memcpy(dest, dir);
                directory = dest;
                offset += dir.len;
            }
            result.stores[i] = .{
                .dirty = meta.dirty,
                .generation = meta.generation,
                .next_image_id = meta.next_image_id,
                .next_internal_placement_id = meta.next_internal_placement_id,
                .total_bytes = meta.total_bytes,
                .total_limit = meta.total_limit,
                .image_limits = .{
                    .file = policy.file,
                    .shared_memory = policy.shared_memory,
                    .preserve_png = policy.preserve_png,
                    .snapshot_file = if (policy.snapshot_file) hooks[i] else null,
                    .temporary_file = if (directory) |dir| .{ .enabled = .{ .directory = dir } } else .disabled,
                },
            };
            const store = &result.stores[i].?;
            try store.images.ensureTotalCapacity(alloc, @intCast(s.images.items.len));
            try store.placements.ensureTotalCapacity(alloc, @intCast(s.placements.items.len));
            for (s.images.items) |*img| {
                store.images.putAssumeCapacityNoClobber(img.id, img.*);
                img.* = .{};
            }
            if (s.loading) |v| {
                const dest = try alloc.create(image.LoadingImage);
                dest.* = v;
                store.loading = dest;
                s.loading = null;
            }
            result.records[i] = s.placements;
            s.placements = .empty;
        };
        return result;
    }

    /// Requires exclusive access to an unpublished destination with matching
    /// reconstructed screens. Do not parse, resize, reset or destroy it during
    /// this call. Bind and rollback never escape that screen-lifetime scope.
    /// On failure neither original store nor its policy is replaced; this
    /// Prepared remains retryable. On success both stores are replaced before
    /// releasing old backing, and the caller owns the returned policy blob.
    /// Source-domain clocks/generations are deliberately not silently rebased.
    pub fn installUnpublished(self: *Prepared, terminal: *Terminal) Error!PolicyBacking {
        if (self.installed) return error.InvalidPhase;
        const alloc = terminal.gpa();
        if (alloc.ptr != self.allocator.ptr or alloc.vtable != self.allocator.vtable) return error.AllocatorMismatch;
        var screens: [2]?*Screen = .{ null, null };
        for (keys, 0..) |key, i| {
            screens[i] = terminal.screens.get(key);
            if ((screens[i] != null) != (self.stores[i] != null)) return error.InvalidSnapshot;
            if (screens[i]) |s| if (s.alloc.ptr != alloc.ptr or s.alloc.vtable != alloc.vtable) return error.AllocatorMismatch;
        }
        if (screens[1] != null and screens[0] == screens[1]) return error.InvalidSnapshot;
        for (&self.stores, 0..) |*slot, i| if (slot.*) |*store| {
            if (store.placements.count() != 0) return error.InvalidSnapshot;
            for (self.records[i].items) |record| {
                if (record.screen != keys[i] or !store.images.contains(record.key.image_id)) return error.InvalidSnapshot;
            }
            for (screens) |s| if (s) |screen| {
                if (aliases(store, &screen.kitty_images)) return error.InvalidSnapshot;
            };
            for (self.stores[0..i]) |*prior| if (prior.*) |*p| {
                if (aliases(store, p)) return error.InvalidSnapshot;
            };
        };
        // No user callback occurs while binding. All failure cleanup untracks
        // only our new pins, against the still-live exact destination screens.
        errdefer for (&self.stores, 0..) |*slot, i| if (slot.*) |*store| {
            var it = store.placements.valueIterator();
            while (it.next()) |place| place.deinit(screens[i].?);
            store.placements.clearRetainingCapacity();
        };
        for (&self.stores, 0..) |*slot, i| if (slot.*) |*store| {
            for (self.records[i].items) |record| {
                var bound = try record.bind(terminal);
                errdefer bound.deinit();
                const entry = try store.placements.getOrPut(alloc, bound.key);
                if (entry.found_existing) return error.InvalidSnapshot;
                entry.value_ptr.* = bound.placement;
            }
        };
        var old: [2]?Storage = .{ null, null };
        for (&self.stores, 0..) |*slot, i| if (slot.*) |store| {
            old[i] = screens[i].?.kitty_images;
            screens[i].?.kitty_images = store;
            slot.* = null;
        };
        const policy = self.policy.?;
        self.policy = null;
        self.installed = true;
        for (&old, 0..) |*slot, i| if (slot.*) |*store| store.deinit(alloc, screens[i].?);
        return policy;
    }
};

fn aliases(a: *const Storage, b: *const Storage) bool {
    return (a.images.metadata != null and a.images.metadata == b.images.metadata) or
        (a.placements.metadata != null and a.placements.metadata == b.placements.metadata) or
        (a.loading != null and a.loading == b.loading);
}

const test_limits: snapshots.Limits = .{ .encoded_bytes = 1 << 20, .backing_bytes = 1 << 20, .images = 100, .placements = 100, .policy_bytes = 4096 };

fn command(t: *Terminal, text: []const u8) !void {
    const alloc = t.gpa();
    const cmd = try @import("graphics_command.zig").Parser.parseString(alloc, text);
    defer cmd.deinit(alloc);
    if (@import("graphics_exec.zig").execute(std.testing.io, alloc, t, &cmd)) |response| try std.testing.expect(response.ok());
}

fn fixture() ![]u8 {
    const alloc = std.testing.allocator;
    var t = try Terminal.init(std.testing.io, alloc, .{ .cols = 8, .rows = 4 });
    defer t.deinit(alloc);
    _ = try t.screens.getInit(std.testing.io, alloc, .alternate, .{ .cols = 8, .rows = 4 });
    for (keys) |key| {
        t.screens.switchTo(key);
        try command(&t, "a=t,f=32,s=1,v=1,i=1;AQIDBA==");
        try command(&t, "a=p,i=1,p=1");
        try command(&t, "a=p,i=1,p=2,P=1,Q=1,H=-3");
        try command(&t, "a=t,f=32,s=1,v=1,i=2,m=1;AQI=");
        const s = &t.screens.active.kitty_images;
        s.image_limits.temporary_file = .{ .enabled = .{ .directory = if (key == .primary) "primary-dir" else "" } };
        _ = try s.addPendingImage(std.testing.io, alloc, t.screens.active, .{ .id = 3, .width = 1, .height = 1, .format = .rgba, .data = .{ .pending = 4 } });
        s.dirty = false;
    }
    return snapshots.capture(alloc, &t, 100, test_limits);
}

test "storage restore both screens ownership and future loading" {
    const testing = std.testing;
    const alloc = testing.allocator;
    const bytes = try fixture();
    defer alloc.free(bytes);
    var prepared = try Prepared.prepare(alloc, bytes, test_limits, null, .{ null, null });
    var prepared_live = true;
    defer if (prepared_live) prepared.deinit();
    const old_token: Storage.PendingImage = .{ .id = 3, .generation = prepared.stores[0].?.images.get(3).?.generation };
    const Mapping = @import("generation_snapshot.zig").Mapping;
    var mapping = try Mapping.fromStorage(alloc, &.{ &prepared.stores[0].?, &prepared.stores[1].? }, &.{old_token.generation}, 100);
    defer mapping.deinit(alloc);
    try mapping.assign(testing.io);
    try mapping.apply(&.{ &prepared.stores[0].?, &prepared.stores[1].? });
    const token: Storage.PendingImage = .{ .id = 3, .generation = try mapping.translate(old_token.generation) };
    var t = try Terminal.init(testing.io, alloc, .{ .cols = 8, .rows = 4 });
    // The policy owner outlives the terminal, not merely the Prepared object.
    var policy: ?PolicyBacking = null;
    defer if (policy) |*p| p.deinit();
    defer t.deinit(alloc);
    _ = try t.screens.getInit(testing.io, alloc, .alternate, .{ .cols = 8, .rows = 4 });
    try command(&t, "a=t,f=32,s=1,v=1,i=99;BAUGBw==");
    try command(&t, "a=p,i=99,p=99");
    const pins = t.screens.active.pages.trackedPins().len;
    policy = try prepared.installUnpublished(&t);
    try testing.expectError(error.InvalidPhase, prepared.installUnpublished(&t));
    prepared.deinit();
    prepared_live = false;
    try testing.expectEqual(pins, t.screens.active.pages.trackedPins().len);
    const completion = try alloc.dupe(u8, &.{ 8, 7, 6, 5 });
    try testing.expect(!old_token.complete(&t.screens.active.kitty_images, testing.io, completion));
    try testing.expect(token.complete(&t.screens.active.kitty_images, testing.io, completion));
    for (keys, 0..) |key, i| {
        const screen = t.screens.get(key).?;
        const store = &screen.kitty_images;
        if (i == 1) try testing.expect(!store.dirty);
        try testing.expect(store.images.get(99) == null);
        try testing.expectEqual(@as(u32, 2), store.images.get(1).?.metadata.placement_count);
        try testing.expectEqualStrings(if (i == 0) "primary-dir" else "", store.image_limits.temporary_file.enabled.directory);
        try testing.expectEqual(@as(usize, 2), store.placements.count());
        t.screens.switchTo(key);
        try command(&t, "m=0;AwQ=");
        try testing.expectEqualSlices(u8, &.{ 1, 2, 3, 4 }, store.images.get(2).?.data.complete);
    }
}

test "storage restore failed final pin binding rolls back and retries" {
    const testing = std.testing;
    const alloc = testing.allocator;
    const bytes = try fixture();
    defer alloc.free(bytes);
    var prepared = try Prepared.prepare(alloc, bytes, test_limits, null, .{ null, null });
    defer prepared.deinit();
    var t = try Terminal.init(testing.io, alloc, .{ .cols = 8, .rows = 4 });
    var policy: ?PolicyBacking = null;
    defer if (policy) |*p| p.deinit();
    defer t.deinit(alloc);
    try testing.expectError(error.InvalidSnapshot, prepared.installUnpublished(&t));
    _ = try t.screens.getInit(testing.io, alloc, .alternate, .{ .cols = 8, .rows = 4 });
    var pins: [2]usize = undefined;
    for (keys, 0..) |key, i| pins[i] = t.screens.get(key).?.pages.trackedPins().len;
    const final = &prepared.records[1].items[prepared.records[1].items.len - 1];
    const saved = final.location;
    final.location = .{ .pin = .{ .x = 999, .y = 0, .garbage = false } };
    try testing.expectError(error.InvalidSnapshot, prepared.installUnpublished(&t));
    for (keys, 0..) |key, i| {
        const screen = t.screens.get(key).?;
        try testing.expectEqual(pins[i], screen.pages.trackedPins().len);
        try testing.expectEqual(@as(u32, 0), screen.kitty_images.images.count());
        try testing.expectEqual(@as(u64, 0), screen.kitty_images.generation);
        try testing.expectEqual(@as(u32, 0), prepared.stores[i].?.placements.count());
    }
    final.location = saved;
    policy = try prepared.installUnpublished(&t);
}

fn failingAssembly(alloc: Allocator, bytes: []const u8) !void {
    var prepared = try Prepared.prepare(alloc, bytes, test_limits, null, .{ null, null });
    defer prepared.deinit();
    var t = try Terminal.init(std.testing.io, alloc, .{ .cols = 8, .rows = 4 });
    var policy: ?PolicyBacking = null;
    defer if (policy) |*p| p.deinit();
    defer t.deinit(alloc);
    _ = try t.screens.getInit(std.testing.io, alloc, .alternate, .{ .cols = 8, .rows = 4 });
    policy = try prepared.installUnpublished(&t);
}

test "storage restore every allocation failure" {
    const bytes = try fixture();
    defer std.testing.allocator.free(bytes);
    try std.testing.checkAllAllocationFailures(std.testing.allocator, failingAssembly, .{bytes});
}

test "storage restore preflight rejects wrong screen allocator and aliases" {
    const testing = std.testing;
    const alloc = testing.allocator;
    const bytes = try fixture();
    defer alloc.free(bytes);
    var prepared = try Prepared.prepare(alloc, bytes, test_limits, null, .{ null, null });
    defer prepared.deinit();
    var t = try Terminal.init(testing.io, alloc, .{ .cols = 8, .rows = 4 });
    defer t.deinit(alloc);
    _ = try t.screens.getInit(testing.io, alloc, .alternate, .{ .cols = 8, .rows = 4 });
    const saved_key = prepared.records[0].items[0].screen;
    prepared.records[0].items[0].screen = .alternate;
    try testing.expectError(error.InvalidSnapshot, prepared.installUnpublished(&t));
    prepared.records[0].items[0].screen = saved_key;
    prepared.allocator = testing.failing_allocator;
    try testing.expectError(error.AllocatorMismatch, prepared.installUnpublished(&t));
    prepared.allocator = alloc;
    const original = t.screens.active.kitty_images;
    t.screens.active.kitty_images = prepared.stores[0].?;
    try testing.expectError(error.InvalidSnapshot, prepared.installUnpublished(&t));
    t.screens.active.kitty_images = original;
    const original_alt = prepared.stores[1].?;
    prepared.stores[1] = prepared.stores[0];
    try testing.expectError(error.InvalidSnapshot, prepared.installUnpublished(&t));
    prepared.stores[1] = original_alt;
    const saved_record = prepared.records[1].items[1];
    prepared.records[1].items[1] = prepared.records[1].items[0];
    const before = t.screens.get(.alternate).?.pages.trackedPins().len;
    try testing.expectError(error.InvalidSnapshot, prepared.installUnpublished(&t));
    try testing.expectEqual(before, t.screens.get(.alternate).?.pages.trackedPins().len);
    prepared.records[1].items[1] = saved_record;
    try testing.expectEqual(@as(u32, 0), t.screens.active.kitty_images.images.count());
}

const FileOwner = struct {
    refs: usize = 1,
    reads: usize = 0,
    fn backing(self: *@This(), id: u64) image.FileBacking {
        return .{ .context = self, .identity = id, .len = 4, .read = read, .release = release };
    }
    fn read(ctx: ?*anyopaque, _: [*]u8, _: usize) callconv(.c) bool {
        const self: *@This() = @ptrCast(@alignCast(ctx.?));
        self.reads += 1;
        return false;
    }
    fn release(ctx: ?*anyopaque) callconv(.c) void {
        const self: *@This() = @ptrCast(@alignCast(ctx.?));
        self.refs -= 1;
    }
    fn resolve(ctx: ?*anyopaque, id: u64, len: usize) images.Error!image.FileBacking {
        const self: *@This() = @ptrCast(@alignCast(ctx.?));
        if (id != 77 or len != 4) return error.BackingUnavailable;
        self.refs += 1;
        return self.backing(88);
    }
    fn resolver(self: *@This()) images.FileResolver {
        return .{ .context = self, .resolve = resolve };
    }
    fn snapshot(_: ?*anyopaque, _: *const image.SnapshotFileRequest, _: *image.FileBacking) bool {
        return false;
    }
    fn hook(self: *@This()) image.SnapshotFileHook {
        return .{ .context = self, .callback = snapshot };
    }
};

fn failingFileAssembly(alloc: Allocator, bytes: []const u8, host: *FileOwner) !void {
    const before = host.refs;
    defer std.debug.assert(host.refs == before);
    var prepared = try Prepared.prepare(alloc, bytes, test_limits, host.resolver(), .{ host.hook(), null });
    defer prepared.deinit();
    var t = try Terminal.init(std.testing.io, alloc, .{ .cols = 8, .rows = 4 });
    var policy: ?PolicyBacking = null;
    defer if (policy) |*p| p.deinit();
    defer t.deinit(alloc);
    // Exercise explicit binding rejection after the earlier pin was acquired.
    const saved = prepared.records[0].items[1].location;
    prepared.records[0].items[1].location = .{ .pin = .{ .x = 999, .y = 0, .garbage = false } };
    if (prepared.installUnpublished(&t)) |unexpected| {
        policy = unexpected;
        return error.TestUnexpectedResult;
    } else |err| switch (err) {
        error.InvalidSnapshot => {},
        else => return err,
    }
    prepared.records[0].items[1].location = saved;
    policy = try prepared.installUnpublished(&t);
    try std.testing.expectEqual(host.hook().context, t.screens.active.kitty_images.image_limits.snapshot_file.?.context);
}

test "storage restore file ownership rollback and destination hook" {
    const testing = std.testing;
    const alloc = testing.allocator;
    var host: FileOwner = .{};
    const bytes = blk: {
        var t = try Terminal.init(testing.io, alloc, .{ .cols = 8, .rows = 4 });
        defer t.deinit(alloc);
        host.refs += 1;
        try t.screens.active.kitty_images.addImage(testing.io, alloc, t.screens.active, .{ .id = 1, .width = 1, .height = 1, .format = .rgba, .data = .{ .native_file = host.backing(77) } });
        try command(&t, "a=p,i=1,p=1");
        try command(&t, "a=p,i=1,p=2");
        t.screens.active.kitty_images.image_limits.snapshot_file = host.hook();
        break :blk try snapshots.capture(alloc, &t, null, test_limits);
    };
    defer alloc.free(bytes);
    try testing.expectError(error.BackingUnavailable, Prepared.prepare(alloc, bytes, test_limits, host.resolver(), .{ null, null }));
    try testing.expectEqual(@as(usize, 1), host.refs);
    try testing.checkAllAllocationFailures(alloc, failingFileAssembly, .{ bytes, &host });
    try testing.expectEqual(@as(usize, 1), host.refs);
    try testing.expectEqual(@as(usize, 0), host.reads);
}
