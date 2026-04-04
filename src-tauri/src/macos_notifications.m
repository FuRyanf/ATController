#import <Cocoa/Cocoa.h>

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"

typedef void (*ClaudexNotificationCompletion)(bool success, const char *error_utf8, void *context);

@interface ClaudexPendingNotification : NSObject
@property(nonatomic, assign) ClaudexNotificationCompletion completion;
@property(nonatomic, assign) void *context;
@end

@implementation ClaudexPendingNotification
@end

@interface ClaudexNotificationDelegate : NSObject <NSUserNotificationCenterDelegate>
@end

static void claudex_resolve_pending_notification(
  NSString *identifier,
  BOOL success,
  NSString * _Nullable errorMessage
);

@implementation ClaudexNotificationDelegate

- (BOOL)userNotificationCenter:(NSUserNotificationCenter *)center
       shouldPresentNotification:(NSUserNotification *)notification
{
  return YES;
}

- (void)userNotificationCenter:(NSUserNotificationCenter *)center
       didDeliverNotification:(NSUserNotification *)notification
{
  if (notification.identifier == nil) {
    return;
  }
  claudex_resolve_pending_notification(notification.identifier, YES, nil);
}

@end

static ClaudexNotificationDelegate *gNotificationDelegate = nil;
static NSMutableDictionary<NSString *, ClaudexPendingNotification *> *gPendingNotifications = nil;

static void claudex_configure_notification_center(void) {
  NSUserNotificationCenter *center = [NSUserNotificationCenter defaultUserNotificationCenter];
  if (gNotificationDelegate == nil) {
    gNotificationDelegate = [ClaudexNotificationDelegate new];
  }
  center.delegate = gNotificationDelegate;
}

static void claudex_complete_notification(
  ClaudexNotificationCompletion completion,
  void *context,
  BOOL success,
  NSString * _Nullable errorMessage
) {
  if (completion == NULL) {
    return;
  }
  completion(success, errorMessage != nil ? errorMessage.UTF8String : NULL, context);
}

static void claudex_resolve_pending_notification(
  NSString *identifier,
  BOOL success,
  NSString * _Nullable errorMessage
) {
  if (identifier == nil || gPendingNotifications == nil) {
    return;
  }

  ClaudexPendingNotification *pending = gPendingNotifications[identifier];
  if (pending == nil) {
    return;
  }

  [gPendingNotifications removeObjectForKey:identifier];
  claudex_complete_notification(pending.completion, pending.context, success, errorMessage);
}

static void claudex_dispatch_to_main(void (^block)(void)) {
  if ([NSThread isMainThread]) {
    block();
    return;
  }
  dispatch_async(dispatch_get_main_queue(), block);
}

static void claudex_dispatch_sync_to_main(void (^block)(void)) {
  if ([NSThread isMainThread]) {
    block();
    return;
  }
  dispatch_sync(dispatch_get_main_queue(), block);
}

bool claudex_notifications_init(void) {
  @autoreleasepool {
    if ([NSThread isMainThread]) {
      claudex_configure_notification_center();
    } else {
      dispatch_sync(dispatch_get_main_queue(), ^{
        claudex_configure_notification_center();
      });
    }
    return true;
  }
}

bool claudex_set_dock_badge_label(const char *label_utf8) {
  @autoreleasepool {
    __block BOOL success = YES;
    claudex_dispatch_sync_to_main(^{
      NSString *label = nil;
      if (label_utf8 != NULL) {
        label = [NSString stringWithUTF8String:label_utf8];
      }
      [[[NSApplication sharedApplication] dockTile] setBadgeLabel:label];
    });
    return success;
  }
}

void claudex_send_notification_async(
  const char *title_utf8,
  const char *body_utf8,
  void *context,
  ClaudexNotificationCompletion completion
) {
  @autoreleasepool {
    claudex_notifications_init();

    NSString *title = title_utf8 != NULL ? [NSString stringWithUTF8String:title_utf8] : @"";
    NSString *body = body_utf8 != NULL ? [NSString stringWithUTF8String:body_utf8] : @"";

    if (title == nil) {
      title = @"";
    }
    if (body == nil) {
      body = @"";
    }

    NSUserNotification *notification = [NSUserNotification new];
    NSString *identifier = [[NSUUID UUID] UUIDString];
    notification.identifier = identifier;
    notification.title = title;
    notification.informativeText = body;
    notification.soundName = NSUserNotificationDefaultSoundName;

    claudex_dispatch_to_main(^{
      NSUserNotificationCenter *center = [NSUserNotificationCenter defaultUserNotificationCenter];
      if (gPendingNotifications == nil) {
        gPendingNotifications = [NSMutableDictionary new];
      }

      ClaudexPendingNotification *pending = [ClaudexPendingNotification new];
      pending.completion = completion;
      pending.context = context;
      gPendingNotifications[identifier] = pending;

      [center deliverNotification:notification];
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        claudex_resolve_pending_notification(
          identifier,
          NO,
          @"Notification was not acknowledged by macOS."
        );
      });
    });
  }
}

#pragma clang diagnostic pop
