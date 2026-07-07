# dualbench — GAIA dual-engine visual diffing bench

Quick side-by-side launch of the GAIA UI in **WebKit** (macOS/iOS target) and
**Chromium** (Windows/Android target) so you can catch rendering divergence
before it reaches production devices.

## Why?

GAIA runs on three platforms, each with a different browser engine:

| Platform   | Engine     | Shell / Runtime                 |
|------------|------------|---------------------------------|
| iOS        | WebKit     | Tauri WKWebView (mandated)      |
| Windows    | Chromium   | Tauri WebView2                  |
| Android    | Chromium   | Tauri WebView / Android System  |

A layout that looks perfect in your dev browser (Chromium) can break silently
on iOS because WebKit handles CSS, flexbox, fonts, scrolling, and touch events
differently. **dualbench makes that gap visible immediately** — open both
engines next to each other and scan for:

- Flex / grid layout shifts
- Font rendering differences (metrics, fallback, ligatures)
- Scrollbar / overflow behavior
- Input focus and keyboard handling
- CSS cascade quirks (gap, backdrop-filter, `:has()`, etc.)
- Any polyfill or feature-gap surprises

## Prerequisites

1. **GAIA daemon running** on `http://127.0.0.1:8787/` — dualbench never starts
   or stops the daemon; it only opens windows that attach.
2. **Tauri shell binary built:**
   ```bash
   cd /Users/pascaldisse/projects/gaia-daemon-tauri
   cargo build
   ```
3. **Brave Browser** (preferred) or **Google Chrome** in `/Applications`.

## Usage

```bash
./run.sh
```

Override the daemon URL (e.g. for a different port):

```bash
GAIA_URL=http://127.0.0.1:3000/ ./run.sh
```

Two windows open:

| Window | Engine       | What it previews          |
|--------|-------------|---------------------------|
| Left   | WebKit      | How iOS users see GAIA    |
| Right  | Chromium    | How Windows/Android users see GAIA |

Arrange them side-by-side and compare visually. Close the Chromium window
normally; kill the Tauri shell with `Ctrl-C` or the printed PID.

## How it works

- **WebKit** — launches the Tauri `gaia-shell` binary directly. On macOS this
  opens a native `WKWebView` window pointed at the daemon URL. No browser chrome,
  no extension interference.
- **Chromium** — opens Brave (or Chrome) in `--app` mode, which strips the URL
  bar, tabs, and bookmarks for a clean application window comparable to the
  Tauri shell.

## Tips

- Use **mission control** or a window manager (Rectangle, Magnet, yabai) to
  snap windows to left/right halves.
- Toggle between light/dark mode in GAIA to check both color schemes.
- Resize both windows to the same dimensions for a pixel-accurate diff.
- Run after every CSS/layout change — the feedback loop is seconds, not a
  full iOS build cycle.

## Files

```
dualbench/
├── README.md   # this file
└── run.sh      # the launcher script (bash)
```
