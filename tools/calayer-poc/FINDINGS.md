# CALayerHost / CAContext cross-process PoC findings

## What this proves

This directory contains a minimal two-process macOS proof of concept for the Chromium-style Remote CoreAnimation path:

- `renderer` creates a private `CAContext` using `+[CAContext contextWithCGSConnection:options:]` and `CGSMainConnectionID()`.
- `renderer` assigns an animated `CALayer` tree as `CAContext.layer`.
- `renderer` publishes `CAContext.contextId` as a decimal `uint32_t` in `/tmp/calayer-poc-context-id.txt` by default.
- `host` creates an `NSWindow`, creates a private `CALayerHost`, sets `CALayerHost.contextId` to that ID, and adds it to the window's layer tree.

## API surface used

Private SPI:

```objc
typedef uint32_t CGSConnectionID;
CGSConnectionID CGSMainConnectionID(void);

@interface CAContext : NSObject
+ (instancetype)contextWithCGSConnection:(CGSConnectionID)connectionID options:(NSDictionary *)options;
@property(nonatomic, readonly) uint32_t contextId;
@property(nonatomic, retain) CALayer *layer;
@end

@interface CALayerHost : CALayer
@property uint32_t contextId;
@end
```

Public API around it:

- `NSApplication`, `NSWindow`, `NSView` from AppKit.
- `CALayer`, `CABasicAnimation`, `CATransaction` from QuartzCore.

The build links only public frameworks (`AppKit`, `QuartzCore`, `Foundation`). `CGSMainConnectionID` is resolved with `dlsym(RTLD_DEFAULT, "CGSMainConnectionID")` so the private symbol is used at runtime without a public header.

## Does contextId alone suffice?

Observed result, matching Chromium's `display_ca_layer_tree.mm`: **yes, the host side only needs the renderer's `CAContext.contextId`**. The host does not pass the renderer's `CGSConnectionID` to `CALayerHost`; it sets only `CALayerHost.contextId`.

The renderer still needs its own `CGSMainConnectionID()` to create the `CAContext` in the first place. That connection ID is not serialized to the host in this PoC, and Chromium's documented handoff path likewise serializes `ca_context_id` rather than the CGS connection ID.

Practical boundary: this is expected to work only within a compatible WindowServer/session/security context. It is private API and not Mac App Store safe.


## Validation performed

On 2026-07-07, in `/Users/pascaldisse/projects/calayer-poc`:

- `./build.sh` completed successfully and produced `./renderer` and `./host`.
- `./renderer` successfully resolved `CGSMainConnectionID`, created a `CAContext`, and wrote a non-zero `CAContext.contextId`.
- `./host` read that exact unsigned 32-bit ID and attached `CALayerHost.contextId` without any renderer CGS connection ID.
- Visual check: the host `NSWindow` displayed the renderer-owned dark layer and animated rounded rectangle in-window.

## How to run

```bash
cd /Users/pascaldisse/projects/calayer-poc
./build.sh
./renderer
# in another terminal:
./host
```

The host should show the renderer's animated colored rectangle live inside the host `NSWindow`.

## How a public IOSurface fallback differs

A public fallback would not host a remote CoreAnimation tree. It would instead:

1. Renderer allocates an `IOSurface` and renders frames into it with Metal or OpenGL.
2. Renderer exports the surface with `IOSurfaceCreateMachPort()` or another supported IOSurface sharing mechanism.
3. IPC sends the Mach port/handle to the host.
4. Host imports it with `IOSurfaceLookupFromMachPort()`.
5. Host wraps the IOSurface as a Metal texture or OpenGL texture and draws a textured quad/layer.

That remains zero-copy at the shared-memory/IOSurface level, but it is texture sharing, not WindowServer-mediated layer hosting. The host must redraw/composite the texture itself and loses the direct remote layer-tree portal behavior of `CAContext` + `CALayerHost`.
