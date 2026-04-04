#import <Cocoa/Cocoa.h>

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"

typedef void (*ATControllerNotificationCompletion)(bool success, const char *error_utf8, void *context);

@interface ATControllerPendingNotification : NSObject
@property(nonatomic, assign) ATControllerNotificationCompletion completion;
@property(nonatomic, assign) void *context;
@end

@implementation ATControllerPendingNotification
@end

@interface ATControllerNotificationDelegate : NSObject <NSUserNotificationCenterDelegate>
@end

static void atcontroller_resolve_pending_notification(
  NSString *identifier,
  BOOL success,
  NSString * _Nullable errorMessage
);

@implementation ATControllerNotificationDelegate

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
  atcontroller_resolve_pending_notification(notification.identifier, YES, nil);
}

@end

static ATControllerNotificationDelegate *gNotificationDelegate = nil;
static NSMutableDictionary<NSString *, ATControllerPendingNotification *> *gPendingNotifications = nil;

static void atcontroller_configure_notification_center(void) {
  NSUserNotificationCenter *center = [NSUserNotificationCenter defaultUserNotificationCenter];
  if (gNotificationDelegate == nil) {
    gNotificationDelegate = [ATControllerNotificationDelegate new];
  }
  center.delegate = gNotificationDelegate;
}

static void atcontroller_complete_notification(
  ATControllerNotificationCompletion completion,
  void *context,
  BOOL success,
  NSString * _Nullable errorMessage
) {
  if (completion == NULL) {
    return;
  }
  completion(success, errorMessage != nil ? errorMessage.UTF8String : NULL, context);
}

static void atcontroller_resolve_pending_notification(
  NSString *identifier,
  BOOL success,
  NSString * _Nullable errorMessage
) {
  if (identifier == nil || gPendingNotifications == nil) {
    return;
  }

  ATControllerPendingNotification *pending = gPendingNotifications[identifier];
  if (pending == nil) {
    return;
  }

  [gPendingNotifications removeObjectForKey:identifier];
  atcontroller_complete_notification(pending.completion, pending.context, success, errorMessage);
}

static void atcontroller_dispatch_to_main(void (^block)(void)) {
  if ([NSThread isMainThread]) {
    block();
    return;
  }
  dispatch_async(dispatch_get_main_queue(), block);
}

static void atcontroller_dispatch_sync_to_main(void (^block)(void)) {
  if ([NSThread isMainThread]) {
    block();
    return;
  }
  dispatch_sync(dispatch_get_main_queue(), block);
}

bool atcontroller_notifications_init(void) {
  @autoreleasepool {
    if ([NSThread isMainThread]) {
      atcontroller_configure_notification_center();
    } else {
      dispatch_sync(dispatch_get_main_queue(), ^{
        atcontroller_configure_notification_center();
      });
    }
    return true;
  }
}

bool atcontroller_set_dock_badge_label(const char *label_utf8) {
  @autoreleasepool {
    __block BOOL success = YES;
    atcontroller_dispatch_sync_to_main(^{
      NSString *label = nil;
      if (label_utf8 != NULL) {
        label = [NSString stringWithUTF8String:label_utf8];
      }
      [[[NSApplication sharedApplication] dockTile] setBadgeLabel:label];
    });
    return success;
  }
}

void atcontroller_send_notification_async(
  const char *title_utf8,
  const char *body_utf8,
  void *context,
  ATControllerNotificationCompletion completion
) {
  @autoreleasepool {
    atcontroller_notifications_init();

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

    atcontroller_dispatch_to_main(^{
      NSUserNotificationCenter *center = [NSUserNotificationCenter defaultUserNotificationCenter];
      if (gPendingNotifications == nil) {
        gPendingNotifications = [NSMutableDictionary new];
      }

      ATControllerPendingNotification *pending = [ATControllerPendingNotification new];
      pending.completion = completion;
      pending.context = context;
      gPendingNotifications[identifier] = pending;

      [center deliverNotification:notification];
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        atcontroller_resolve_pending_notification(
          identifier,
          NO,
          @"Notification was not acknowledged by macOS."
        );
      });
    });
  }
}

#pragma clang diagnostic pop
