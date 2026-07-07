#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import <CoreGraphics/CoreGraphics.h>
#import <dlfcn.h>
#import <sys/wait.h>

// Private CoreGraphics/SkyLight SPI candidates. Loaded dynamically; no private headers.
typedef int32_t CGSConnectionID;
typedef CGSConnectionID (*MainConnectionIDFn)(void);
typedef int32_t (*SetWindowParentFn)(CGSConnectionID cid, uint32_t child, uint32_t parent);
typedef int32_t (*GetWindowContextOutFn)(CGSConnectionID cid, uint32_t window, uint32_t *contextOut);

// Private QuartzCore SPI: CALayerHost displays a remote CAContext by contextId.
@interface CALayerHost : CALayer
@property uint32_t contextId;
@end

static NSString *NowStamp(void) {
  NSDateFormatter *fmt = [NSDateFormatter new];
  fmt.dateFormat = @"yyyy-MM-dd HH:mm:ss.SSS";
  return [fmt stringFromDate:[NSDate date]];
}

static void *OpenSkyLight(void) {
  static void *handle = NULL;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    handle = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY | RTLD_LOCAL);
    if (!handle) handle = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/Versions/A/SkyLight", RTLD_LAZY | RTLD_LOCAL);
  });
  return handle;
}

static void *ResolveSymbol(const char *name) {
  void *p = dlsym(RTLD_DEFAULT, name);
  if (!p) {
    void *sky = OpenSkyLight();
    if (sky) p = dlsym(sky, name);
  }
  return p;
}

static MainConnectionIDFn ResolveMainConnection(NSMutableArray<NSString *> *log) {
  const char *names[] = {"CGSMainConnectionID", "SLSMainConnectionID", NULL};
  for (int i = 0; names[i]; ++i) {
    MainConnectionIDFn fn = (MainConnectionIDFn)ResolveSymbol(names[i]);
    if (fn) {
      [log addObject:[NSString stringWithFormat:@"resolved %s", names[i]]];
      return fn;
    }
  }
  [log addObject:@"missing CGSMainConnectionID/SLSMainConnectionID"];
  return NULL;
}

static NSString *FindBraveExecutable(void) {
  NSArray<NSString *> *candidates = @[
    @"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    [NSHomeDirectory() stringByAppendingPathComponent:@"Applications/Brave Browser.app/Contents/MacOS/Brave Browser"],
    @"/Applications/Brave Browser Beta.app/Contents/MacOS/Brave Browser Beta",
    @"/Applications/Brave Browser Nightly.app/Contents/MacOS/Brave Browser Nightly"
  ];
  NSFileManager *fm = NSFileManager.defaultManager;
  for (NSString *path in candidates) {
    if ([fm isExecutableFileAtPath:path]) return path;
  }
  return nil;
}

static NSDictionary *FirstWindowForPid(pid_t pid, uint32_t excludingWindow) {
  NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
  NSDictionary *fallback = nil;
  for (NSDictionary *w in windows) {
    NSNumber *ownerPid = w[(NSString *)kCGWindowOwnerPID];
    NSNumber *num = w[(NSString *)kCGWindowNumber];
    NSNumber *layer = w[(NSString *)kCGWindowLayer];
    if (!ownerPid || !num || !layer) continue;
    if (ownerPid.intValue != pid) continue;
    if (num.unsignedIntValue == excludingWindow) continue;
    if (layer.intValue != 0) continue;
    CGRect bounds = CGRectZero;
    CGRectMakeWithDictionaryRepresentation((CFDictionaryRef)w[(NSString *)kCGWindowBounds], &bounds);
    if (bounds.size.width < 80 || bounds.size.height < 80) continue;
    if (!fallback) fallback = w;
    NSString *name = w[(NSString *)kCGWindowName];
    if (!name) name = @"";
    if ([name localizedCaseInsensitiveContainsString:@"Example"] || [name localizedCaseInsensitiveContainsString:@"installed-embed"]) return w;
  }
  return fallback;
}

static NSArray<NSString *> *SymbolAvailability(NSArray<NSString *> *names) {
  NSMutableArray<NSString *> *out = [NSMutableArray array];
  for (NSString *name in names) {
    [out addObject:[NSString stringWithFormat:@"%@: %@", name, ResolveSymbol(name.UTF8String) ? @"present" : @"missing"]];
  }
  return out;
}

static BOOL ProbeContextSymbol(const char *name, CGSConnectionID cid, uint32_t windowID, uint32_t *contextOut, NSString **detailOut) {
  void *sym = ResolveSymbol(name);
  if (!sym) {
    if (detailOut) *detailOut = [NSString stringWithFormat:@"%s missing", name];
    return NO;
  }

  int pipefd[2];
  if (pipe(pipefd) != 0) {
    if (detailOut) *detailOut = [NSString stringWithFormat:@"%s present but pipe() failed", name];
    return NO;
  }
  pid_t child = fork();
  if (child == 0) {
    close(pipefd[0]);
    uint32_t found = 0;
    int32_t rc = ((GetWindowContextOutFn)sym)(cid, windowID, &found);
    dprintf(pipefd[1], "%d %u", rc, found);
    close(pipefd[1]);
    _exit(0);
  }
  close(pipefd[1]);
  char buf[128] = {0};
  ssize_t n = read(pipefd[0], buf, sizeof(buf) - 1);
  close(pipefd[0]);
  int status = 0;
  waitpid(child, &status, 0);
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
    if (detailOut) *detailOut = [NSString stringWithFormat:@"%s present but probe crashed/status=0x%x", name, status];
    return NO;
  }
  int rc = -9999;
  unsigned parsed = 0;
  if (n > 0) sscanf(buf, "%d %u", &rc, &parsed);
  if (detailOut) *detailOut = [NSString stringWithFormat:@"%s present probe rc=%d context=%u", name, rc, parsed];
  if (rc == 0 && parsed > 0) {
    if (contextOut) *contextOut = parsed;
    return YES;
  }
  return NO;
}

@interface AppDelegate : NSObject <NSApplicationDelegate>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) CALayer *rootLayer;
@property(nonatomic, strong) NSTask *braveTask;
@property(nonatomic, strong) NSString *bravePath;
@property(nonatomic, strong) NSString *workDir;
@property(nonatomic, strong) NSString *reportPath;
@property(nonatomic, strong) NSString *initialURL;
@property(nonatomic, strong) NSString *navigateURL;
@property(nonatomic) NSInteger port;
@property(nonatomic) NSInteger autoExitSeconds;
@property(nonatomic, strong) NSMutableArray<NSString *> *log;
@end

@implementation AppDelegate
- (void)addLog:(NSString *)line {
  NSString *full = [NSString stringWithFormat:@"[%@] %@", NowStamp(), line];
  NSLog(@"%@", full);
  @synchronized (self.log) { [self.log addObject:full]; }
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  self.log = [NSMutableArray array];
  if (!self.port) self.port = 9333;
  if (!self.initialURL) self.initialURL = @"https://example.com/?gaia-installed-embed=initial";
  if (!self.navigateURL) self.navigateURL = @"https://example.org/?gaia-installed-embed=cdp";

  NSString *base = [NSTemporaryDirectory() stringByAppendingPathComponent:[NSString stringWithFormat:@"gaia-installed-embed-%d", getpid()]];
  self.workDir = base;
  self.reportPath = [base stringByAppendingPathComponent:@"last-run.md"];
  [NSFileManager.defaultManager createDirectoryAtPath:base withIntermediateDirectories:YES attributes:nil error:nil];

  [self createHostWindow];
  [self addLog:[NSString stringWithFormat:@"host pid=%d windowNumber=%ld", getpid(), (long)self.window.windowNumber]];

  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    [self runMilestoneProbe];
  });

  if (self.autoExitSeconds > 0) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(self.autoExitSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      [self addLog:[NSString stringWithFormat:@"auto-exit after %ld seconds", (long)self.autoExitSeconds]];
      [NSApp terminate:nil];
    });
  }
}

- (void)createHostWindow {
  NSRect frame = NSMakeRect(120, 160, 960, 680);
  self.window = [[NSWindow alloc] initWithContentRect:frame
                                           styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable | NSWindowStyleMaskMiniaturizable)
                                             backing:NSBackingStoreBuffered
                                               defer:NO];
  self.window.title = @"GAIA installed Chromium embed PoC host";
  NSView *view = self.window.contentView;
  view.wantsLayer = YES;
  self.rootLayer = [CALayer layer];
  self.rootLayer.frame = view.bounds;
  self.rootLayer.autoresizingMask = kCALayerWidthSizable | kCALayerHeightSizable;
  self.rootLayer.backgroundColor = CGColorCreateGenericRGB(0.015, 0.02, 0.025, 1.0);
  view.layer = self.rootLayer;

  CATextLayer *label = [CATextLayer layer];
  label.string = @"installed-embed host window: waiting for Brave scratch window";
  label.foregroundColor = CGColorCreateGenericRGB(0.0, 0.85, 0.78, 1.0);
  label.fontSize = 18;
  label.frame = CGRectMake(24, 24, 880, 44);
  CGFloat scale = NSScreen.mainScreen.backingScaleFactor;
  label.contentsScale = scale > 0 ? scale : 2.0;
  [self.rootLayer addSublayer:label];

  [self.window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
}

- (BOOL)isPortAlreadyListening {
  NSString *cmd = [NSString stringWithFormat:@"/usr/sbin/lsof -nP -iTCP:%ld -sTCP:LISTEN >/dev/null 2>&1", (long)self.port];
  int rc = system(cmd.UTF8String);
  return rc == 0;
}

- (BOOL)launchBrave {
  if ([self isPortAlreadyListening]) {
    [self addLog:[NSString stringWithFormat:@"port %ld is already listening; refusing to attach to an unknown browser", (long)self.port]];
    return NO;
  }
  self.bravePath = FindBraveExecutable();
  if (!self.bravePath) {
    [self addLog:@"Brave executable not found in /Applications or ~/Applications"];
    return NO;
  }
  NSString *profile = [self.workDir stringByAppendingPathComponent:@"brave-profile"];
  [NSFileManager.defaultManager createDirectoryAtPath:profile withIntermediateDirectories:YES attributes:nil error:nil];

  self.braveTask = [NSTask new];
  self.braveTask.executableURL = [NSURL fileURLWithPath:self.bravePath];
  self.braveTask.arguments = @[
    [NSString stringWithFormat:@"--remote-debugging-port=%ld", (long)self.port],
    [NSString stringWithFormat:@"--user-data-dir=%@", profile],
    @"--no-first-run",
    @"--no-default-browser-check",
    @"--new-window",
    self.initialURL
  ];
  self.braveTask.standardOutput = [NSPipe pipe];
  self.braveTask.standardError = [NSPipe pipe];
  NSError *error = nil;
  BOOL ok = [self.braveTask launchAndReturnError:&error];
  if (!ok) {
    [self addLog:[NSString stringWithFormat:@"failed to launch Brave: %@", error.localizedDescription]];
    return NO;
  }
  [self addLog:[NSString stringWithFormat:@"launched Brave pid=%d path=%@", self.braveTask.processIdentifier, self.bravePath]];
  [self addLog:[NSString stringWithFormat:@"initial URL: %@", self.initialURL]];
  return YES;
}

- (NSDictionary *)waitForBraveWindow {
  for (int i = 0; i < 100; ++i) {
    NSDictionary *w = FirstWindowForPid(self.braveTask.processIdentifier, (uint32_t)self.window.windowNumber);
    if (w) return w;
    usleep(150 * 1000);
  }
  return nil;
}

- (void)runMilestoneProbe {
  if (![self launchBrave]) { [self writeReport]; return; }

  NSDictionary *braveWindow = [self waitForBraveWindow];
  if (!braveWindow) {
    [self addLog:@"no on-screen Brave window found for launched pid"];
    [self writeReport];
    return;
  }
  uint32_t braveWindowID = [braveWindow[(NSString *)kCGWindowNumber] unsignedIntValue];
  NSString *title = braveWindow[(NSString *)kCGWindowName];
  if (!title) title = @"";
  [self addLog:[NSString stringWithFormat:@"found Brave window id=%u title=%@", braveWindowID, title]];

  NSMutableArray<NSString *> *spiLog = [NSMutableArray array];
  MainConnectionIDFn mainConnFn = ResolveMainConnection(spiLog);
  for (NSString *line in spiLog) [self addLog:line];
  CGSConnectionID cid = mainConnFn ? mainConnFn() : 0;
  [self addLog:[NSString stringWithFormat:@"CGS/SLS main connection id=%d", cid]];

  [self attemptWindowReparent:braveWindowID connection:cid];
  [self attemptWindowContextHost:braveWindowID connection:cid];
  [self driveCDPNavigation];
  [self writeReport];
}

- (void)attemptWindowReparent:(uint32_t)braveWindowID connection:(CGSConnectionID)cid {
  [self addLog:@"mechanism A: CGS/SLS window reparenting attempt"];
  NSArray<NSString *> *symbols = @[@"SLSSetWindowParent", @"CGSSetWindowParent", @"_SLPSSetWindowParent", @"SLPSSetWindowParent", @"_SLSSetWindowParent", @"_CGSSetWindowParent"];
  for (NSString *line in SymbolAvailability(symbols)) [self addLog:[@"  " stringByAppendingString:line]];
  if (!cid) { [self addLog:@"mechanism A result: skipped; no main CGS/SLS connection"] ; return; }
  for (NSString *name in symbols) {
    SetWindowParentFn fn = (SetWindowParentFn)ResolveSymbol(name.UTF8String);
    if (!fn) continue;
    int32_t rc = fn(cid, braveWindowID, (uint32_t)self.window.windowNumber);
    [self addLog:[NSString stringWithFormat:@"mechanism A result: called %@(%d, child=%u, parent=%u) rc=%d", name, cid, braveWindowID, (uint32_t)self.window.windowNumber, rc]];
    return;
  }
  [self addLog:@"mechanism A result: no known window-parenting symbol was exported/resolvable on this macOS build"];
}

- (void)attemptWindowContextHost:(uint32_t)braveWindowID connection:(CGSConnectionID)cid {
  [self addLog:@"mechanism B: obtain Brave window CAContext/contextId then CALayerHost it"];
  NSArray<NSString *> *symbols = @[
    @"SLSGetWindowContextID", @"CGSGetWindowContextID", @"SLSGetWindowContextId", @"CGSGetWindowContextId",
    @"SLSGetWindowCAContextID", @"CGSGetWindowCAContextID", @"SLSGetWindowCAContextId", @"CGSGetWindowCAContextId",
    @"SLSGetWindowLayerContextID", @"CGSGetWindowLayerContextID", @"SLSGetWindowBackingContextID", @"CGSGetWindowBackingContextID"
  ];
  for (NSString *line in SymbolAvailability(symbols)) [self addLog:[@"  " stringByAppendingString:line]];
  if (!cid) { [self addLog:@"mechanism B result: skipped; no main CGS/SLS connection"] ; return; }

  uint32_t contextID = 0;
  for (NSString *name in symbols) {
    NSString *detail = nil;
    BOOL ok = ProbeContextSymbol(name.UTF8String, cid, braveWindowID, &contextID, &detail);
    [self addLog:[@"  " stringByAppendingString:(detail ? detail : name)]];
    if (ok) break;
  }

  if (!contextID) {
    [self addLog:@"mechanism B result: no Brave window CAContext/contextId could be obtained from the available CGS/SLS surface"];
    return;
  }

  dispatch_sync(dispatch_get_main_queue(), ^{
    Class hostClass = NSClassFromString(@"CALayerHost");
    if (!hostClass) {
      [self addLog:@"mechanism B result: CALayerHost class missing"];
      return;
    }
    CALayerHost *remote = [[hostClass alloc] init];
    remote.frame = self.rootLayer.bounds;
    remote.autoresizingMask = kCALayerWidthSizable | kCALayerHeightSizable;
    remote.contextId = contextID;
    [self.rootLayer addSublayer:remote];
    [self addLog:[NSString stringWithFormat:@"mechanism B result: attached CALayerHost.contextId=%u", contextID]];
  });
}

- (void)driveCDPNavigation {
  [self addLog:@"CDP: driving Page.navigate over :9333"];
  NSString *cwdScript = [[[NSFileManager.defaultManager currentDirectoryPath] stringByAppendingPathComponent:@"cdp_navigate.py"] stringByStandardizingPath];
  NSTask *task = [NSTask new];
  task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/python3"];
  task.arguments = @[cwdScript, @"--port", [NSString stringWithFormat:@"%ld", (long)self.port], @"--url", self.navigateURL, @"--timeout", @"15"];
  NSPipe *outPipe = [NSPipe pipe];
  NSPipe *errPipe = [NSPipe pipe];
  task.standardOutput = outPipe;
  task.standardError = errPipe;
  NSError *error = nil;
  if (![task launchAndReturnError:&error]) {
    [self addLog:[NSString stringWithFormat:@"CDP result: failed to run helper: %@", error.localizedDescription]];
    return;
  }
  [task waitUntilExit];
  NSString *out = [[NSString alloc] initWithData:[outPipe.fileHandleForReading readDataToEndOfFile] encoding:NSUTF8StringEncoding];
  if (!out) out = @"";
  NSString *err = [[NSString alloc] initWithData:[errPipe.fileHandleForReading readDataToEndOfFile] encoding:NSUTF8StringEncoding];
  if (!err) err = @"";
  [self addLog:[NSString stringWithFormat:@"CDP helper exit=%d", task.terminationStatus]];
  if (out.length) [self addLog:[NSString stringWithFormat:@"CDP stdout: %@", out]];
  if (err.length) [self addLog:[NSString stringWithFormat:@"CDP stderr: %@", err]];
}

- (void)writeReport {
  NSMutableString *md = [NSMutableString string];
  [md appendString:@"# installed-embed last run\n\n"];
  [md appendFormat:@"- Time: %@\n", NowStamp()];
  [md appendFormat:@"- Host pid: %d\n", getpid()];
  [md appendFormat:@"- Host window id: %u\n", (uint32_t)self.window.windowNumber];
  [md appendFormat:@"- Brave pid: %d\n", self.braveTask ? self.braveTask.processIdentifier : -1];
  [md appendFormat:@"- Port: %ld\n", (long)self.port];
  [md appendFormat:@"- Initial URL: %@\n", self.initialURL];
  [md appendFormat:@"- CDP navigate URL: %@\n\n", self.navigateURL];
  [md appendString:@"## Log\n\n```\n"];
  @synchronized (self.log) {
    for (NSString *line in self.log) [md appendFormat:@"%@\n", line];
  }
  [md appendString:@"```\n"];
  NSError *error = nil;
  [md writeToFile:self.reportPath atomically:YES encoding:NSUTF8StringEncoding error:&error];
  if (error) [self addLog:[NSString stringWithFormat:@"failed to write report: %@", error.localizedDescription]];
  else [self addLog:[NSString stringWithFormat:@"wrote report %@", self.reportPath]];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender { return YES; }

- (void)applicationWillTerminate:(NSNotification *)notification {
  if (self.braveTask && self.braveTask.isRunning) {
    [self addLog:[NSString stringWithFormat:@"terminating scratch Brave pid=%d", self.braveTask.processIdentifier]];
    [self.braveTask terminate];
  }
}
@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    AppDelegate *delegate = [AppDelegate new];
    delegate.port = 9333;
    delegate.autoExitSeconds = 0;
    for (int i = 1; i < argc; ++i) {
      NSString *arg = [NSString stringWithUTF8String:argv[i]];
      if ([arg isEqualToString:@"--auto-exit-seconds"] && i + 1 < argc) delegate.autoExitSeconds = atoi(argv[++i]);
      else if ([arg isEqualToString:@"--port"] && i + 1 < argc) delegate.port = atoi(argv[++i]);
      else if ([arg isEqualToString:@"--url"] && i + 1 < argc) delegate.initialURL = [NSString stringWithUTF8String:argv[++i]];
      else if ([arg isEqualToString:@"--navigate-url"] && i + 1 < argc) delegate.navigateURL = [NSString stringWithUTF8String:argv[++i]];
    }
    NSApp.delegate = delegate;
    [NSApp run];
  }
  return 0;
}
