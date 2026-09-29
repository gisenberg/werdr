#ifndef GHOSTTY_VT_GRAPHICS_SNAPSHOT_H
#define GHOSTTY_VT_GRAPHICS_SNAPSHOT_H

#include <ghostty/vt/allocator.h>
#include <ghostty/vt/terminal.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Private GSTOR1 graphics domain, not a complete runtime handoff format. */
typedef struct {
  size_t size;
  size_t encoded_bytes;
  size_t backing_bytes;
  size_t images;
  size_t placements;
  size_t policy_bytes;
} GhosttyGraphicsSnapshotLimitsV1;

/** Borrowed backing, valid only during this callback.
 * Retain an independent host reference without reading pixels.
 * On capture failure the host must release any references already retained.
 * Callbacks must not reenter or mutate the terminal.
 */
typedef bool (*GhosttyGraphicsSnapshotRetainFn)(
    void *context, const GhosttyKittyImageFileBacking *backing);

/** Success transfers one destination-owned reference with matching length and
 * non-null read/release callbacks. Failure transfers nothing.
 * The native decoder releases successful references on any later rejection.
 * Context must have the provenance expected by the destination host.
 * Callbacks must not reenter or mutate the terminal.
 */
typedef bool (*GhosttyGraphicsSnapshotResolveFn)(
    void *context, uint64_t identity, size_t len,
    GhosttyKittyImageFileBacking *out_backing);

/** Capture both existing screens under exclusive access.
 * Does not activate screens, read files, decode pixels or emit protocol effects.
 * A retain callback is required for native-file backing.
 * Output uses allocator and must be released with ghostty_free.
 * Limits cover logical backing and record counts, not allocator capacity/RSS.
 * C terminals have no ticker: clock authority is absent and timestamps stay raw.
 * Pending producer-backed images reject; partial protocol uploads are supported.
 */
GHOSTTY_API GhosttyResult ghostty_graphics_snapshot_encode_alloc(
    GhosttyTerminal terminal, const GhosttyAllocator *allocator,
    const GhosttyGraphicsSnapshotLimitsV1 *limits,
    GhosttyGraphicsSnapshotRetainFn retain, void *context,
    uint8_t **out_ptr, size_t *out_len);

/** Restore into an exclusively held, unpublished reconstructed terminal.
 * Apply global graphics/APC policy and destination snapshot-file callbacks first.
 * Exact existing screen presence is required; screens are never created here.
 * Maps, pins and wrapper-owned directory backing replace transactionally.
 * Generations and saved loading-frame references rebind together to fresh stamps.
 * Clock-bearing records and pending producer-backed images reject unchanged.
 * Source timestamps remain opaque because the C terminal has no animation ticker.
 * The host must coordinate process/effect fences, attachments and fresh caches
 * before publication. This function does not establish cross-process migration.
 */
GHOSTTY_API GhosttyResult ghostty_graphics_snapshot_restore(
    GhosttyTerminal terminal, const uint8_t *input, size_t len,
    const GhosttyGraphicsSnapshotLimitsV1 *limits,
    GhosttyGraphicsSnapshotResolveFn resolve, void *context);

#ifdef __cplusplus
}
#endif

#endif
