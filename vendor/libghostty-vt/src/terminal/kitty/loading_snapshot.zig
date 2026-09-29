//! Quiescent, retained chunked-image state. This is not storage installation.
//! Frame generations remain source-domain references until coordinated remapping.
//! Initialization-only directory/hook pointers are deliberately never read.
const std = @import("std");
const command = @import("graphics_command.zig");
const image = @import("graphics_image.zig");
const LoadingImage = image.LoadingImage;
const Allocator = std.mem.Allocator;
pub const Error = error{ InvalidSnapshot, LimitExceeded, OutOfMemory };
pub const Limits = struct { encoded_bytes: usize, backing_bytes: usize };
const magic = "LDGST1";
const header_len = 256;
const max_payload = 400 * 1024 * 1024;

// Explicit schemas freeze field order independently of native struct layout.
// Field-count checks force review when upstream adds continuation state.
const display_fields = .{ "image_id", "image_number", "placement_id", "x", "y", "width", "height", "x_offset", "y_offset", "columns", "rows", "cursor_movement", "virtual_placement", "parent_id", "parent_placement_id", "horizontal_offset", "vertical_offset", "z" };
const transmission_fields = .{ "format", "format_unknown", "medium", "width", "height", "size", "offset", "image_id", "image_number", "placement_id", "compression", "more_chunks", "usage" };
const frame_fields = .{ "transmission", "x", "y", "create_frame", "edit_frame", "gap_ms", "composition_mode", "background" };
const response_fields = .{ "id", "image_number", "placement_id", "frame", "message" };

fn enumNames(comptime T: type) []const []const u8 {
    return if (T == command.Transmission.Format) &.{ "rgb", "rgba", "png", "gray_alpha", "gray" } else if (T == command.Transmission.Medium) &.{ "direct", "file", "temporary_file", "shared_memory" } else if (T == command.Transmission.Compression) &.{ "none", "zlib_deflate" } else if (T == command.Command.Quiet) &.{ "no", "ok", "failures" } else if (T == command.Display.CursorMovement) &.{ "after", "none" } else if (T == command.CompositionMode) &.{ "alpha_blend", "overwrite" } else @compileError("unreviewed snapshot enum");
}

fn Codec(comptime writing: bool) type {
    return struct {
        bytes: if (writing) []u8 else []const u8,
        offset: usize = magic.len,
        const Self = @This();

        fn fields(self: *Self, ptr: anytype, comptime names: anytype) Error!void {
            const T = @typeInfo(@TypeOf(ptr)).pointer.child;
            comptime std.debug.assert(@typeInfo(T).@"struct".fields.len == names.len);
            inline for (names) |name| try self.value(&@field(ptr.*, name));
        }

        fn value(self: *Self, ptr: anytype) Error!void {
            const T = @typeInfo(@TypeOf(ptr)).pointer.child;
            if (T == command.Display) return self.fields(ptr, display_fields);
            if (T == command.Transmission) return self.fields(ptr, transmission_fields);
            if (T == command.AnimationFrameLoading) return self.fields(ptr, frame_fields);
            if (T == command.Response) return self.fields(ptr, response_fields);
            if (T == command.Transmission.Usage) {
                var raw: u32 = if (writing) @as(u32, @intFromBool(ptr.transient)) | (@as(u32, ptr._padding) << 1) else 0;
                try self.value(&raw);
                if (!writing) ptr.* = .{ .transient = raw & 1 != 0, ._padding = @intCast(raw >> 1) };
                return;
            }
            if (T == command.AnimationFrameLoading.Background) {
                var raw: u32 = if (writing) (@as(u32, ptr.r) << 24) | (@as(u32, ptr.g) << 16) | (@as(u32, ptr.b) << 8) | ptr.a else 0;
                try self.value(&raw);
                if (!writing) ptr.* = .{ .r = @truncate(raw >> 24), .g = @truncate(raw >> 16), .b = @truncate(raw >> 8), .a = @truncate(raw) };
                return;
            }
            if (T == []const u8) {
                // Retained responses only contain static OK. Errors are local
                // response copies, and LoadingImage has no message ownership.
                if (writing and !std.mem.eql(u8, ptr.*, "OK")) return error.InvalidSnapshot;
                if (!writing) ptr.* = "OK";
                return;
            }
            switch (@typeInfo(T)) {
                .int => {
                    if (self.offset + @sizeOf(T) > header_len) return error.InvalidSnapshot;
                    const bytes = self.bytes[self.offset..][0..@sizeOf(T)];
                    if (writing) std.mem.writeInt(T, bytes, ptr.*, .little) else ptr.* = std.mem.readInt(T, bytes, .little);
                    self.offset += @sizeOf(T);
                },
                .bool => {
                    var raw: u8 = if (writing) @intFromBool(ptr.*) else 0;
                    try self.value(&raw);
                    if (raw > 1) return error.InvalidSnapshot;
                    if (!writing) ptr.* = raw == 1;
                },
                .@"enum" => {
                    const names = comptime enumNames(T);
                    comptime std.debug.assert(@typeInfo(T).@"enum".fields.len == names.len);
                    var raw: u8 = 255;
                    if (writing) inline for (names, 0..) |name, i| {
                        if (ptr.* == @field(T, name)) raw = i;
                    };
                    try self.value(&raw);
                    if (raw >= names.len) return error.InvalidSnapshot;
                    if (!writing) inline for (names, 0..) |name, i| {
                        if (raw == i) ptr.* = @field(T, name);
                    };
                },
                .optional => |opt| {
                    var present = if (writing) ptr.* != null else false;
                    try self.value(&present);
                    if (present) {
                        var v: opt.child = if (writing) ptr.*.? else .{};
                        try self.value(&v);
                        if (!writing) ptr.* = v;
                    } else if (!writing) ptr.* = null;
                },
                else => @compileError("unreviewed snapshot field type"),
            }
        }

        fn loading(self: *Self, v: *LoadingImage, payload_len: *u64) Error!void {
            comptime std.debug.assert(@typeInfo(LoadingImage).@"struct".fields.len == 8);
            comptime std.debug.assert(@typeInfo(image.Image).@"struct".fields.len == 10);
            try self.value(payload_len);
            try self.value(&v.image.id);
            try self.value(&v.image.number);
            try self.value(&v.image.width);
            try self.value(&v.image.height);
            try self.value(&v.image.format);
            try self.value(&v.image.compression);
            var transient = v.image.metadata.transient;
            var implicit = v.image.metadata.implicit_id;
            try self.value(&transient);
            try self.value(&implicit);
            if (!writing) {
                v.image.metadata.transient = transient;
                v.image.metadata.implicit_id = implicit;
            }
            try self.value(&v.quiet);
            try self.value(&v.response);
            try self.value(&v.display);
            var has_frame = v.frame != null;
            try self.value(&has_frame);
            if (has_frame) {
                var frame: LoadingImage.FrameContext = if (writing) v.frame.? else .{ .cmd = .{}, .image_generation = 0 };
                comptime std.debug.assert(@typeInfo(LoadingImage.FrameContext).@"struct".fields.len == 2);
                try self.value(&frame.cmd);
                try self.value(&frame.image_generation);
                if (!writing) v.frame = frame;
            }
        }
    };
}

fn budget(payload_len: usize, limits: Limits) Error!usize {
    if (payload_len > max_payload) return error.InvalidSnapshot;
    const encoded = std.math.add(usize, header_len, payload_len) catch return error.LimitExceeded;
    if (encoded > limits.encoded_bytes or payload_len > limits.backing_bytes) return error.LimitExceeded;
    return encoded;
}

/// Only accepts state published as storage.loading between commands, not an
/// initializing or completing local LoadingImage. Capture has no side effects.
pub fn encode(alloc: Allocator, source: *const LoadingImage, limits: Limits) Error![]u8 {
    if (source.image.data != .complete or source.image.data.complete.len != 0 or
        source.image.animation != null or source.image.generation != 0 or
        source.image.metadata.placement_count != 0) return error.InvalidSnapshot;
    const len = try budget(source.data.items.len, limits);
    var header: [header_len]u8 = @splat(0);
    @memcpy(header[0..magic.len], magic);
    var codec: Codec(true) = .{ .bytes = &header };
    // Copy scalar state, but never dereference borrowed init-only pointers.
    var v = source.*;
    var payload_len: u64 = source.data.items.len;
    try codec.loading(&v, &payload_len);
    const bytes = try alloc.alloc(u8, len);
    @memcpy(bytes[0..header_len], &header);
    @memcpy(bytes[header_len..], source.data.items);
    return bytes;
}

/// Owns only accumulated payload; dead initialization-only policy is null.
/// No PNG/decompression validation, file I/O, callbacks or command replay occurs.
pub fn decode(alloc: Allocator, bytes: []const u8, limits: Limits) Error!LoadingImage {
    if (bytes.len > limits.encoded_bytes) return error.LimitExceeded;
    if (bytes.len < header_len or !std.mem.eql(u8, bytes[0..magic.len], magic)) return error.InvalidSnapshot;
    var result: LoadingImage = .{ .image = .{}, .quiet = .no, .temporary_directory = null };
    var codec: Codec(false) = .{ .bytes = bytes[0..header_len] };
    var payload_len: u64 = 0;
    try codec.loading(&result, &payload_len);
    if (!std.mem.allEqual(u8, bytes[codec.offset..header_len], 0)) return error.InvalidSnapshot;
    const len = std.math.cast(usize, payload_len) orelse return error.InvalidSnapshot;
    if (try budget(len, limits) != bytes.len) return error.InvalidSnapshot;
    result.data = try .initCapacity(alloc, len);
    result.data.appendSliceAssumeCapacity(bytes[header_len..]);
    return result;
}

const test_limits: Limits = .{ .encoded_bytes = 1 << 20, .backing_bytes = 1 << 20 };

fn copyLoading(source: *const LoadingImage) !LoadingImage {
    const alloc = std.testing.allocator;
    const bytes = try encode(alloc, source, test_limits);
    defer alloc.free(bytes);
    var result = try decode(alloc, bytes, test_limits);
    errdefer result.deinit(alloc);
    const after = try encode(alloc, &result, test_limits);
    defer alloc.free(after);
    try std.testing.expectEqualSlices(u8, bytes, after);
    return result;
}

test "loading snapshot resumes every raw image cut" {
    const testing = std.testing;
    const alloc = testing.allocator;
    inline for (.{ command.Transmission.Format.rgb, command.Transmission.Format.rgba, command.Transmission.Format.gray_alpha, command.Transmission.Format.gray }) |format| {
        const pixels = "0123456789ABCDEF"[0 .. 2 * command.Transmission.formatBpp(format)];
        for (0..pixels.len + 1) |cut| {
            const cmd: command.Command = .{
                .control = .{ .transmit = .{ .width = 2, .height = 1, .format = format, .more_chunks = true } },
                .data = pixels[0..cut],
            };
            var source = try LoadingImage.init(testing.io, alloc, &cmd, .direct);
            // Automatic image IDs and saved response IDs are distinct.
            source.image.id = 700;
            source.image.metadata.implicit_id = true;
            var restored = try copyLoading(&source);
            defer restored.deinit(alloc);
            source.deinit(alloc);
            try restored.addData(alloc, pixels[cut..]);
            var completed = try restored.complete(alloc);
            defer completed.deinit(alloc);
            try testing.expectEqualSlices(u8, pixels, completed.data.complete);
            try testing.expectEqual(@as(u32, 700), completed.id);
            try testing.expect(completed.metadata.implicit_id);
            try testing.expectEqual(@as(u32, 0), restored.response.id);
        }
    }
}

test "loading snapshot exact deferred commands and dead initialization policy" {
    const testing = std.testing;
    const alloc = testing.allocator;
    var source: LoadingImage = .{
        .image = .{ .id = 19, .number = 5, .width = 0, .height = std.math.maxInt(u32), .format = .png, .compression = .zlib_deflate, .metadata = .{ .transient = true } },
        .quiet = .failures,
        .response = .{ .id = 4, .image_number = 8, .placement_id = 9, .frame = 17 },
        .temporary_directory = null,
        .display = .{ .image_id = 1, .image_number = 2, .placement_id = 3, .x = 4, .y = 5, .width = 6, .height = 7, .x_offset = 8, .y_offset = 9, .columns = 10, .rows = 11, .cursor_movement = .none, .virtual_placement = true, .parent_id = 12, .parent_placement_id = 13, .horizontal_offset = -14, .vertical_offset = std.math.minInt(i32), .z = std.math.maxInt(i32) },
        .frame = .{ .image_generation = std.math.maxInt(u64), .cmd = .{
            .transmission = .{ .format = .gray, .format_unknown = true, .medium = .temporary_file, .width = 1, .height = 2, .size = 3, .offset = 4, .image_id = 5, .image_number = 6, .placement_id = 7, .compression = .zlib_deflate, .more_chunks = true, .usage = .{ .transient = true, ._padding = 123 } },
            .x = 11,
            .y = 12,
            .create_frame = 13,
            .edit_frame = 14,
            .gap_ms = -15,
            .composition_mode = .overwrite,
            .background = .{ .r = 255, .g = 128, .b = 64, .a = 0 },
        } },
    };
    defer source.deinit(alloc);
    try source.addData(alloc, "unfinished\x00compressed PNG");
    // A freed directory is legal after wrapper policy replacement. Capture
    // must not consult it, nor invoke the initialization-only file hook.
    const directory = try alloc.dupe(u8, "expired directory");
    source.temporary_directory = directory;
    alloc.free(directory);
    source.snapshot_file = .{ .context = null, .callback = struct {
        fn unexpected(_: ?*anyopaque, _: *const image.SnapshotFileRequest, _: *image.FileBacking) bool {
            @panic("snapshot invoked initialization-only file hook");
        }
    }.unexpected };
    var restored = try copyLoading(&source);
    defer restored.deinit(alloc);
    try testing.expect(restored.temporary_directory == null);
    try testing.expect(restored.snapshot_file == null);
    source.temporary_directory = null;
    source.snapshot_file = null;
    var expected = source;
    expected.data.capacity = restored.data.capacity;
    try testing.expectEqualDeep(expected, restored);
}

fn decodeFailing(alloc: Allocator, bytes: []const u8) !void {
    var result = try decode(alloc, bytes, test_limits);
    defer result.deinit(alloc);
}

test "loading snapshot malformed limits and allocation cleanup" {
    const testing = std.testing;
    const alloc = testing.allocator;
    var source: LoadingImage = .{ .image = .{}, .quiet = .ok, .temporary_directory = null };
    defer source.deinit(alloc);
    try source.addData(alloc, "partial");
    const bytes = try encode(alloc, &source, test_limits);
    defer alloc.free(bytes);
    try testing.checkAllAllocationFailures(alloc, decodeFailing, .{bytes});
    for (0..bytes.len) |len| try testing.expectError(error.InvalidSnapshot, decode(testing.failing_allocator, bytes[0..len], test_limits));
    try testing.expectError(error.LimitExceeded, decode(testing.failing_allocator, bytes, .{ .encoded_bytes = bytes.len - 1, .backing_bytes = 7 }));
    try testing.expectError(error.LimitExceeded, decode(testing.failing_allocator, bytes, .{ .encoded_bytes = bytes.len, .backing_bytes = 6 }));
    for ([_]usize{ 0, 6, 30, 31, 32, 33, 34, 51, 52, 255 }) |offset| {
        const saved = bytes[offset];
        bytes[offset] = 255;
        try testing.expectError(error.InvalidSnapshot, decode(testing.failing_allocator, bytes, test_limits));
        bytes[offset] = saved;
    }
    source.response.message = "not a retained response";
    try testing.expectError(error.InvalidSnapshot, encode(testing.failing_allocator, &source, test_limits));
    source.response.message = "OK";
    source.image.generation = 1;
    try testing.expectError(error.InvalidSnapshot, encode(testing.failing_allocator, &source, test_limits));
}

fn replaceLoading(storage: *@import("graphics_storage.zig").ImageStorage) !void {
    const alloc = std.testing.allocator;
    const bytes = try encode(alloc, storage.loading.?, test_limits);
    defer alloc.free(bytes);
    const replacement = try alloc.create(LoadingImage);
    errdefer alloc.destroy(replacement);
    replacement.* = try decode(alloc, bytes, test_limits);
    storage.loading.?.destroy(alloc);
    storage.loading = replacement;
}

test "loading snapshot frame continuation and stale target" {
    const testing = std.testing;
    const alloc = testing.allocator;
    const execute = @import("graphics_exec.zig").execute;
    const Terminal = @import("../Terminal.zig");
    for ([_]bool{ false, true }) |restore| for ([_]bool{ false, true }) |stale| {
        for ([_][]const u8{ "a=f,m=0;AAD/", "m=0;AAD/" }) |continuation| {
            var t = try Terminal.init(testing.io, alloc, .{ .rows = 5, .cols = 5 });
            defer t.deinit(alloc);
            const storage = &t.screens.active.kitty_images;
            const root = try command.Parser.parseString(alloc, "a=t,f=24,s=2,v=1,i=1;////////");
            defer root.deinit(alloc);
            try testing.expect(execute(testing.io, alloc, &t, &root).?.ok());
            const first = try command.Parser.parseString(alloc, "a=f,i=1,f=24,s=2,v=1,z=60,m=1;/wAA");
            defer first.deinit(alloc);
            try testing.expect(execute(testing.io, alloc, &t, &first) == null);
            if (restore) try replaceLoading(storage);
            if (stale) storage.imagePtrByIdOrNumber(1, 0).?.generation += 1;
            const last = try command.Parser.parseString(alloc, continuation);
            defer last.deinit(alloc);
            const response = execute(testing.io, alloc, &t, &last).?;
            try testing.expectEqual(!stale, response.ok());
            try testing.expectEqual(@as(u32, 1), response.id);
            try testing.expect(storage.loading == null);
            const img = storage.imagePtrByIdOrNumber(1, 0).?;
            if (!stale) {
                try testing.expectEqual(@as(u32, 2), response.frame);
                try testing.expectEqual(@as(u32, 60), img.animation.?.frames.items[0].gap_ms);
                try testing.expectEqualSlices(u8, &.{ 255, 0, 0, 255, 0, 0, 255, 255 }, img.animation.?.frames.items[0].data);
            } else try testing.expect(img.animation == null);
        }
    };
}

test "loading snapshot quiet survives failed append and deferred completion errors" {
    const testing = std.testing;
    const alloc = testing.allocator;
    const execute = @import("graphics_exec.zig").execute;
    const Terminal = @import("../Terminal.zig");
    for ([_][]const u8{ "f=100,i=7,m=1;AA==", "f=32,o=z,s=1,v=1,i=7,m=1;AA==", "f=32,s=0,v=1,i=7,m=1;AA==" }) |input| {
        var t = try Terminal.init(testing.io, alloc, .{ .rows = 5, .cols = 5 });
        defer t.deinit(alloc);
        const storage = &t.screens.active.kitty_images;
        const first = try command.Parser.parseString(alloc, input);
        defer first.deinit(alloc);
        try testing.expect(execute(testing.io, alloc, &t, &first) == null);
        const extra: [512]u8 = @splat(1);
        const failed: command.Command = .{ .quiet = .ok, .control = .{ .transmit = .{ .more_chunks = true } }, .data = &extra };
        var failing = testing.FailingAllocator.init(alloc, .{ .fail_index = 0, .resize_fail_index = 0 });
        try testing.expect(!execute(testing.io, failing.allocator(), &t, &failed).?.ok());
        try testing.expectEqual(command.Command.Quiet.ok, storage.loading.?.quiet);
        try testing.expectEqualSlices(u8, &.{0}, storage.loading.?.data.items);
        try replaceLoading(storage);
        try testing.expectEqual(command.Command.Quiet.ok, storage.loading.?.quiet);
        const last: command.Command = .{ .control = .{ .transmit = .{} } };
        const response = execute(testing.io, alloc, &t, &last).?;
        try testing.expect(!response.ok());
        try testing.expectEqual(@as(u32, 7), response.id);
        try testing.expect(storage.loading == null);
        try testing.expectEqual(@as(usize, 0), storage.images.count());
    }
}

test "loading snapshot optional command layouts" {
    const testing = std.testing;
    for ([_]bool{ false, true }) |display| for ([_]bool{ false, true }) |frame| {
        var source: LoadingImage = .{
            .image = .{},
            .quiet = .no,
            .temporary_directory = null,
            .display = if (display) .{ .z = -1 } else null,
            .frame = if (frame) .{ .cmd = .{}, .image_generation = 42 } else null,
        };
        var result = try copyLoading(&source);
        defer result.deinit(testing.allocator);
        try testing.expectEqualDeep(source, result);
    };
}

test "loading snapshot deferred display with automatic image identity" {
    const testing = std.testing;
    const alloc = testing.allocator;
    const execute = @import("graphics_exec.zig").execute;
    const Terminal = @import("../Terminal.zig");
    var t = try Terminal.init(testing.io, alloc, .{ .rows = 5, .cols = 5 });
    defer t.deinit(alloc);
    const storage = &t.screens.active.kitty_images;
    const first = try command.Parser.parseString(alloc, "a=T,f=32,s=1,v=1,I=12,m=1,C=1,c=2,r=1;AQI=");
    defer first.deinit(alloc);
    try testing.expect(execute(testing.io, alloc, &t, &first) == null);
    const id = storage.loading.?.image.id;
    try testing.expect(id != 0);
    try testing.expectEqual(@as(u32, 0), storage.loading.?.response.id);
    try testing.expectEqual(@as(u32, 12), storage.loading.?.response.image_number);
    try replaceLoading(storage);
    const last = try command.Parser.parseString(alloc, "m=0;AwQ=");
    defer last.deinit(alloc);
    const response = execute(testing.io, alloc, &t, &last).?;
    try testing.expect(response.ok());
    try testing.expectEqual(id, response.id);
    try testing.expectEqual(@as(u32, 12), response.image_number);
    try testing.expect(storage.loading == null);
    try testing.expectEqual(@as(usize, 1), storage.placements.count());
    try testing.expectEqualSlices(u8, &.{ 1, 2, 3, 4 }, storage.imageById(id).?.data.complete);
}
