#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>

// Private QuartzCore SPI: CALayerHost displays a remote CAContext by contextId.
@interface CALayerHost : CALayer
@property uint32_t contextId;
@end

static NSString *ContextPath(int argc, const char *argv[]) {
  if (argc > 1) return [NSString stringWithUTF8String:argv[1]];
  return @"/tmp/calayer-poc-context-id.txt";
}

static uint32_t ReadContextId(NSString *path) {
  for (int i = 0; i < 100; ++i) {
    NSError *error = nil;
    NSString *s = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:&error];
    if (s.length > 0) {
      unsigned long parsed = strtoul(s.UTF8String, NULL, 10);
      if (parsed > 0 && parsed <= UINT32_MAX) return (uint32_t)parsed;
    }
    usleep(100 * 1000);
  }
  return 0;
}

@interface AppDelegate : NSObject <NSApplicationDelegate>
@property(nonatomic) uint32_t contextId;
@property(nonatomic, strong) NSWindow *window;
@end

@implementation AppDelegate
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  NSRect frame = NSMakeRect(180, 180, 640, 480);
  self.window = [[NSWindow alloc]
      initWithContentRect:frame
                styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                           NSWindowStyleMaskResizable | NSWindowStyleMaskMiniaturizable)
                  backing:NSBackingStoreBuffered
                    defer:NO];
  self.window.title = [NSString stringWithFormat:@"CALayerHost contextId=%u", self.contextId];

  NSView *view = self.window.contentView;
  view.wantsLayer = YES;
  CALayer *root = [CALayer layer];
  root.frame = view.bounds;
  root.autoresizingMask = kCALayerWidthSizable | kCALayerHeightSizable;
  root.backgroundColor = CGColorCreateGenericRGB(0.02, 0.02, 0.025, 1.0);
  view.layer = root;

  Class hostClass = NSClassFromString(@"CALayerHost");
  if (!hostClass) {
    NSLog(@"CALayerHost class not present. This private SPI is unavailable.");
    [NSApp terminate:nil];
    return;
  }

  CALayerHost *remote = [[hostClass alloc] init];
  remote.frame = root.bounds;
  remote.autoresizingMask = kCALayerWidthSizable | kCALayerHeightSizable;
  remote.contextId = self.contextId;
  [root addSublayer:remote];

  [self.window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
  NSLog(@"host pid=%d attached CALayerHost.contextId=%u", getpid(), self.contextId);
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
  return YES;
}
@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSString *path = ContextPath(argc, argv);
    uint32_t contextId = ReadContextId(path);
    if (contextId == 0) {
      fprintf(stderr, "No non-zero contextId found at %s. Start ./renderer first.\n", path.UTF8String);
      return 2;
    }

    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    AppDelegate *delegate = [AppDelegate new];
    delegate.contextId = contextId;
    NSApp.delegate = delegate;
    [NSApp run];
  }
  return 0;
}
