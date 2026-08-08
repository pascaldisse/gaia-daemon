# Installed Chromium/Brave embedding findings

Milestone A asks whether a native macOS window we own can embed an **unmodified, already-installed Brave** process. Short answer from this PoC: **not cleanly as a WebView2-style embeddable webview**.

- **Window reparenting:** the private `SLSSetWindowParent` call is present and returned success, but the Brave window remained a separate WindowServer top-level surface in validation. This is at best a private window-ordering/ownership trick, not a reliable in-window webview surface.
- **CALayerHost/contextId:** the host-side `CALayerHost` path still requires the renderer/GPU process `CAContext.contextId`. The tested CGS/SLS surface did not expose a Brave window CAContext/contextId for an unmodified installed Brave. Without Chromium cooperation/patching, there is no token to hand to `CALayerHost`.
- **CDP control:** remote debugging on `:9333` worked; the PoC drove `Page.navigate` over the CDP websocket on the scratch Brave profile.

## What was built

Directory: `tools/installed-embed/`

- `build.sh` — compiles the Objective-C/AppKit PoC.
- `installed_embed.m` — launches Brave with a temporary `--user-data-dir`, owns a host `NSWindow`, probes CGS/SLS reparenting symbols, probes candidate window-context symbols, and invokes the CDP navigation helper.
- `cdp_navigate.py` — stdlib-only CDP websocket helper that sends `Page.enable` and `Page.navigate`.
- `README.md` — run instructions.

Run:

```bash
cd /Users/pascaldisse/projects/gaia-cef/tools/installed-embed
./build.sh
./installed_embed --auto-exit-seconds 20
```

The run writes `/tmp`/`$TMPDIR` output like:

```text
/var/folders/.../T/gaia-installed-embed-<pid>/last-run.md
```

The PoC intentionally uses only harmless example URLs and does not touch GAIA `:8787`.

## Validation performed

Date: 2026-07-07.

Before validation, port `9333` was occupied by an older `/private/tmp/cef-rs/.../cefsimple` process from the prior Chromium-shell milestone. I killed only that stale `cefsimple` process to free the required scratch CDP port; I did **not** start/stop/navigate the GAIA daemon.

Successful validation run:

```text
host pid=29841 windowNumber=20457
launched Brave pid=29846 path=/Applications/Brave Browser.app/Contents/MacOS/Brave Browser
initial URL: https://example.com/?gaia-installed-embed=initial
found Brave window id=20462 title=Untitled
resolved CGSMainConnectionID
CGS/SLS main connection id=953407
```

### Mechanism A: CGS/SLS window reparenting

Private symbols probed:

```text
SLSSetWindowParent: present
CGSSetWindowParent: present
_SLPSSetWindowParent: missing
SLPSSetWindowParent: missing
_SLSSetWindowParent: missing
_CGSSetWindowParent: missing
```

Call attempted:

```text
SLSSetWindowParent(953407, child=20462, parent=20457) rc=0
```

Result: **not accepted as a clean embed**.

Evidence:

- Host screenshot captured by window id `20457` showed only the host window's own dark layer and label, not Brave content.
- Brave screenshot captured by window id `20462` showed the live Brave window navigated to `example.org`.
- `CGWindowListCopyWindowInfo` still reported Brave's content window `20462` as a separate on-screen Brave Browser window with bounds `{ X = 22; Y = 56; Width = 1200; Height = 904; }`, while the host window `20457` remained separate with bounds `{ X = 120; Y = 110; Width = 960; Height = 712; }`.

So `SLSSetWindowParent` returning `0` is not enough. With this minimal private call, unmodified Brave did not become a child surface clipped/resized inside our `NSWindow`. It may affect ordering/ownership metadata, or additional private window-management calls may be needed, but this is not a WebView2-equivalent composition surface and it is not true CA zero-copy embedding.

### Mechanism B: get Brave CAContext/contextId and host it via CALayerHost

Private context getter candidates probed:

```text
SLSGetWindowContextID: missing
CGSGetWindowContextID: missing
SLSGetWindowContextId: missing
CGSGetWindowContextId: missing
SLSGetWindowCAContextID: missing
CGSGetWindowCAContextID: missing
SLSGetWindowCAContextId: missing
CGSGetWindowCAContextId: missing
SLSGetWindowLayerContextID: missing
CGSGetWindowLayerContextID: missing
SLSGetWindowBackingContextID: missing
CGSGetWindowBackingContextID: missing
```

Result: **failed for unmodified installed Brave**.

`CALayerHost` itself is available, and the earlier `tools/calayer-poc` proved that `CALayerHost.contextId` works when our renderer process mints and publishes the `CAContext.contextId`. The missing piece here is extracting Brave/Chromium's internal GPU-process `CAContext.contextId` from outside the unmodified browser. This PoC did not find an exported CGS/SLS window-server API that provides it for a Brave top-level window.

## CDP control result

CDP websocket control worked on the scratch Brave remote-debugging port:

```json
{
  "fromUrl": "https://example.com/?gaia-installed-embed=initial",
  "navigate": {
    "id": 2,
    "result": {
      "frameId": "A07B5A8C3B39322590068BD9309AF258",
      "isDownload": false,
      "loaderId": "1FB87E0FDFB87B5F2D759CBC115E5509"
    }
  },
  "targetId": "A07B5A8C3B39322590068BD9309AF258"
}
```

The corresponding Brave window showed:

```text
https://example.org/?gaia-installed-embed=cdp
```

## Exact private API surface used/probed

Used:

```objc
typedef int32_t CGSConnectionID;
CGSConnectionID CGSMainConnectionID(void); // via dlsym
int32_t SLSSetWindowParent(CGSConnectionID cid, uint32_t child, uint32_t parent); // via dlsym
```

Also found/probed:

```objc
int32_t CGSSetWindowParent(CGSConnectionID cid, uint32_t child, uint32_t parent); // present, not called after SLS variant succeeded
```

Host-side CA private class available but not usable without a valid context id:

```objc
@interface CALayerHost : CALayer
@property uint32_t contextId;
@end
```

Probed but missing on this macOS build: the `SLSGetWindow*Context*` / `CGSGetWindow*Context*` candidate names listed above.

## Limitations and implications

- **Input/events:** CDP can drive browser navigation and automation, but the reparent attempt does not give a reliable host-owned event path. If using window overlay/reparent tricks, input still routes to the Brave window, not a Tauri-owned webview abstraction.
- **Resize/DPI:** no reliable child clipping/resizing was established. Brave kept its own WindowServer bounds.
- **Multi-window:** Brave owns real top-level windows. Popups/tabs remain Brave window-management concerns unless a separate broker constrains them.
- **Zero-copy:** mechanism A is not a zero-copy layer handoff; it is a WindowServer window relationship attempt. Mechanism B would be zero-copy through WindowServer, but it requires a `CAContext.contextId` that unmodified Brave does not expose externally.
- **Security/private API:** `SLSSetWindowParent`, `CGSMainConnectionID`, and `CALayerHost`/`CAContext` are private/unsupported surfaces and not Mac App Store safe.

## Honest verdict

For Milestone A, **neither candidate gives a clean, supported embed of an unmodified installed Brave into our native macOS `NSWindow`**.

The closest achievable path without patching Chromium is a fragile private window-management/overlay model around Brave's real window plus CDP for control. That is not equivalent to WebView2 composition mode and does not provide a host-owned webview surface.

For the real `CALayerHost` design already proven by `tools/calayer-poc`, Chromium/Brave must cooperate by exposing the GPU-process `CAContext.contextId` (or an IOSurface/Mach-port fallback). That means patching/embedding a cooperating Chromium runtime or convincing installed browsers to provide a WebView2-like macOS runtime API; stock Brave does not appear to provide it externally.
