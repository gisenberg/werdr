//! Shared allocation accounting for a decoder and its returned terminal.
//! The page adapter preserves the caller's OS-backed allocation semantics.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Budget = @This();

owner: Allocator,
heap: Adapter,
pages: Adapter,
references: std.atomic.Value(usize) = .init(1),
used: std.atomic.Value(usize) = .init(0),
peak: std.atomic.Value(usize) = .init(0),
limit: usize,
enforcing: std.atomic.Value(bool) = .init(true),
limit_exceeded: std.atomic.Value(bool) = .init(false),

pub fn create(owner: Allocator, page_allocator: Allocator, limit: usize) Allocator.Error!*Budget {
    const result = try owner.create(Budget);
    result.* = .{
        .owner = owner,
        .heap = .{ .budget = result, .child = owner, .page_backing = false },
        .pages = .{ .budget = result, .child = page_allocator, .page_backing = true },
        .limit = limit,
    };
    return result;
}

pub fn retain(self: *Budget) *Budget {
    _ = self.references.fetchAdd(1, .monotonic);
    return self;
}

pub fn release(self: *Budget) void {
    if (self.references.fetchSub(1, .acq_rel) != 1) return;
    std.debug.assert(self.used.load(.acquire) == 0);
    const owner = self.owner;
    owner.destroy(self);
}

pub fn finish(self: *Budget) void {
    // Keep both adapters alive for subsequent allocations and frees.
    self.enforcing.store(false, .release);
}

pub fn heapAllocator(self: *Budget) Allocator {
    return self.heap.allocator();
}

pub fn pageAllocator(self: *Budget) Allocator {
    return self.pages.allocator();
}

fn reserve(self: *Budget, amount: usize) bool {
    var used = self.used.load(.monotonic);
    while (true) {
        const total = std.math.add(usize, used, amount) catch {
            self.limit_exceeded.store(true, .monotonic);
            return false;
        };
        if (self.enforcing.load(.acquire) and total > self.limit) {
            self.limit_exceeded.store(true, .monotonic);
            return false;
        }
        if (self.used.cmpxchgWeak(used, total, .monotonic, .monotonic)) |actual| {
            used = actual;
        } else {
            _ = self.peak.fetchMax(total, .monotonic);
            return true;
        }
    }
}

fn refund(self: *Budget, amount: usize) void {
    const previous = self.used.fetchSub(amount, .monotonic);
    std.debug.assert(previous >= amount);
}

const Adapter = struct {
    budget: *Budget,
    child: Allocator,
    page_backing: bool,

    fn charge(self: *const Adapter, len: usize) ?usize {
        if (!self.page_backing) return len;
        const page_size = std.heap.pageSize();
        const padded = std.math.add(usize, len, page_size - 1) catch return null;
        return padded & ~(page_size - 1);
    }

    fn allocator(self: *Adapter) Allocator {
        return .{ .ptr = self, .vtable = &.{ .alloc = alloc, .resize = resize, .remap = remap, .free = free } };
    }

    fn alloc(ctx: *anyopaque, len: usize, alignment: std.mem.Alignment, ra: usize) ?[*]u8 {
        const self: *Adapter = @ptrCast(@alignCast(ctx));
        const amount = self.charge(len) orelse {
            self.budget.limit_exceeded.store(true, .monotonic);
            return null;
        };
        if (!self.budget.reserve(amount)) return null;
        return self.child.rawAlloc(len, alignment, ra) orelse {
            self.budget.refund(amount);
            return null;
        };
    }

    fn resize(_: *anyopaque, _: []u8, _: std.mem.Alignment, _: usize, _: usize) bool {
        // Force allocate/copy/free so transient old+new storage is accounted.
        return false;
    }

    fn remap(_: *anyopaque, _: []u8, _: std.mem.Alignment, _: usize, _: usize) ?[*]u8 {
        return null;
    }

    fn free(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, ra: usize) void {
        const self: *Adapter = @ptrCast(@alignCast(ctx));
        const amount = self.charge(memory.len) orelse unreachable;
        self.child.rawFree(memory, alignment, ra);
        self.budget.refund(amount);
    }
};

test "snapshot budget combines heap and rounded page charges" {
    const testing = std.testing;
    const page_size = std.heap.pageSize();
    const budget = try create(testing.allocator, testing.allocator, page_size);
    defer budget.release();
    const heap = budget.heapAllocator();
    const pages = budget.pageAllocator();
    const first = try heap.alloc(u8, 32);
    try testing.expectError(error.OutOfMemory, pages.alloc(u8, 1));
    heap.free(first);
    const page = try pages.alloc(u8, 1);
    try testing.expectEqual(page_size, budget.used.load(.monotonic));
    try testing.expectEqual(page_size, budget.peak.load(.monotonic));
    const retained = budget.retain();
    budget.finish();
    const later = try heap.alloc(u8, 64);
    heap.free(later);
    pages.free(page);
    retained.release();
    try testing.expectEqual(0, budget.used.load(.monotonic));
}

test "snapshot budget refunds underlying failure and rejects overflow" {
    const testing = std.testing;
    var failing = testing.FailingAllocator.init(testing.allocator, .{ .fail_index = 0 });
    const budget = try create(testing.allocator, failing.allocator(), std.math.maxInt(usize));
    defer budget.release();
    try testing.expectError(error.OutOfMemory, budget.pageAllocator().alloc(u8, 1));
    try testing.expectEqual(0, budget.used.load(.monotonic));
    try testing.expect(budget.pages.charge(std.math.maxInt(usize)) == null);
    try testing.expect(budget.reserve(std.math.maxInt(usize)));
    try testing.expect(!budget.reserve(1));
    budget.refund(std.math.maxInt(usize));
}
