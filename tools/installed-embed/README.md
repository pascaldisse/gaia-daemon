# installed-embed PoC

Milestone A probe for embedding an unmodified installed Chromium-family browser on macOS.
It launches the installed Brave binary with a scratch profile and `--remote-debugging-port=9333`, opens a host `NSWindow`, then attempts:

1. CGS/SLS window reparenting of Brave's real top-level window into the host window.
2. CGS/SLS discovery of a Brave window CAContext/contextId, followed by host-side `CALayerHost.contextId` attachment.
3. CDP `Page.navigate` over the scratch remote debugging port.

It never navigates GAIA `:8787`.

```bash
cd /Users/pascaldisse/projects/gaia-cef/tools/installed-embed
./build.sh
./installed_embed --auto-exit-seconds 20
```

The run writes `/tmp/gaia-installed-embed-<pid>/last-run.md`.
