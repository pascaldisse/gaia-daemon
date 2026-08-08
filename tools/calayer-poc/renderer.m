#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import <dlfcn.h>

// Private CoreAnimation / CoreGraphics SPI. Mirrors Chromium's remote_layer_api.h shape.
typedef uint32_t CGSConnectionID;

typedef CGSConnectionID (*CGSMainConnectionIDFn)(void);

@interface CAContext : NSObject
+ (instancetype)contextWithCGSConnection:(CGSConnectionID)connectionID options:(NSDictionary *)options;
@property(nonatomic, readonly) uint32_t contextId;
@property(nonatomic, retain) CALayer *layer;
@end

static NSString *ContextPath(int argc, const char *argv[]) {
  if (argc > 1) return [NSString stringWithUTF8String:argv[1]];
  return @"/tmp/calayer-poc-context-id.txt";
}

static CGColorRef Color(CGFloat r, CGFloat g, CGFloat b, CGFloat a) {
  return CGColorCreateGenericRGB(r, g, b, a);
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    Class caContextClass = NSClassFromString(@"CAContext");
    if (!caContextClass) {
      fprintf(stderr, "CAContext class not present. This private SPI is unavailable.\n");
      return 2;
    }

    CGSMainConnectionIDFn cgsMainConnectionID =
        (CGSMainConnectionIDFn)dlsym(RTLD_DEFAULT, "CGSMainConnectionID");
    if (!cgsMainConnectionID) {
      fprintf(stderr, "CGSMainConnectionID symbol not found.\n");
      return 3;
    }

    CGSConnectionID connectionID = cgsMainConnectionID();
    CAContext *context = [caContextClass contextWithCGSConnection:connectionID options:@{}];
    if (!context) {
      fprintf(stderr, "Failed to create CAContext.\n");
      return 4;
    }

    CALayer *root = [CALayer layer];
    root.frame = CGRectMake(0, 0, 640, 480);
    root.bounds = CGRectMake(0, 0, 640, 480);
    root.anchorPoint = CGPointMake(0, 0);
    root.opaque = YES;
    CGColorRef bg = Color(0.06, 0.08, 0.12, 1.0);
    root.backgroundColor = bg;
    CGColorRelease(bg);

    CALayer *rect = [CALayer layer];
    rect.bounds = CGRectMake(0, 0, 140, 90);
    rect.position = CGPointMake(90, 130);
    rect.cornerRadius = 18;
    CGColorRef teal = Color(0.00, 0.85, 0.78, 1.0);
    rect.backgroundColor = teal;
    CGColorRelease(teal);
    rect.shadowOpacity = 0.45;
    rect.shadowRadius = 16;
    rect.shadowOffset = CGSizeMake(0, 8);
    [root addSublayer:rect];

    CABasicAnimation *move = [CABasicAnimation animationWithKeyPath:@"position"];
    move.fromValue = [NSValue valueWithPoint:NSMakePoint(90, 130)];
    move.toValue = [NSValue valueWithPoint:NSMakePoint(550, 350)];
    move.duration = 1.8;
    move.autoreverses = YES;
    move.repeatCount = HUGE_VALF;
    move.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseInEaseOut];
    [rect addAnimation:move forKey:@"calayer-poc-moving-rect"];

    CABasicAnimation *hue = [CABasicAnimation animationWithKeyPath:@"backgroundColor"];
    CGColorRef magenta = Color(0.95, 0.16, 0.75, 1.0);
    hue.fromValue = (__bridge id)rect.backgroundColor;
    hue.toValue = (__bridge id)magenta;
    hue.duration = 1.8;
    hue.autoreverses = YES;
    hue.repeatCount = HUGE_VALF;
    [rect addAnimation:hue forKey:@"calayer-poc-color"];
    CGColorRelease(magenta);

    context.layer = root;
    [CATransaction flush];

    uint32_t contextId = context.contextId;
    NSString *path = ContextPath(argc, argv);
    NSString *payload = [NSString stringWithFormat:@"%u\n", contextId];
    NSError *error = nil;
    if (![payload writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:&error]) {
      fprintf(stderr, "Failed to write contextId to %s: %s\n", path.UTF8String,
              error.localizedDescription.UTF8String);
      return 5;
    }

    printf("renderer pid=%d CGSConnectionID=%u CAContext.contextId=%u path=%s\n",
           getpid(), connectionID, contextId, path.UTF8String);
    fflush(stdout);

    // Keep CAContext/root alive and service the main run loop.
    [[NSRunLoop mainRunLoop] run];
  }
  return 0;
}
