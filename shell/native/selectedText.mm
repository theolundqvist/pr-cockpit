#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#include <node_api.h>
#include <string>
#include <cstring>
#include <atomic>
#include <chrono>
#include <mutex>
#include <thread>

static std::atomic<uint64_t> generation{0};
static std::mutex captureMutex;
using Clock = std::chrono::steady_clock;

struct Capture {
  napi_async_work work;
  napi_deferred deferred;
  pid_t pid;
  uint64_t generation;
  Clock::time_point deadline;
  const char* status = "unavailable";
  std::string text;
};

static CFTypeRef attribute(AXUIElementRef element, CFStringRef name) {
  CFTypeRef value = nullptr;
  AXUIElementCopyAttributeValue(element, name, &value);
  return value;
}

static bool protectedElement(AXUIElementRef element) {
  CFTypeRef subrole = attribute(element, kAXSubroleAttribute);
  bool secure = subrole && CFEqual(subrole, CFSTR("AXSecureTextField"));
  if (subrole) CFRelease(subrole);
  CFTypeRef protectedContent = attribute(element, CFSTR("AXProtectedContent"));
  secure = secure || (protectedContent && CFEqual(protectedContent, kCFBooleanTrue));
  if (protectedContent) CFRelease(protectedContent);
  return secure;
}

static bool setText(Capture* capture, CFTypeRef value) {
  if (!value || CFGetTypeID(value) != CFStringGetTypeID()) return false;
  NSData* utf8 = [(__bridge NSString*)value dataUsingEncoding:NSUTF8StringEncoding];
  if (!utf8) return false;
  if (utf8.length) capture->text.assign(static_cast<const char*>(utf8.bytes), utf8.length);
  capture->status = "ok";
  return true;
}

static bool current(Capture* capture) {
  return capture->generation == generation.load() && Clock::now() < capture->deadline;
}

static AXUIElementRef copyMenuItem(AXUIElementRef element, Capture* capture, int depth = 0) {
  if (!current(capture) || depth > 4) return nullptr;
  AXUIElementSetMessagingTimeout(element, 0.1);
  CFTypeRef key = attribute(element, kAXMenuItemCmdCharAttribute);
  bool copy = key && CFGetTypeID(key) == CFStringGetTypeID()
    && CFStringCompare((CFStringRef)key, CFSTR("c"), kCFCompareCaseInsensitive) == kCFCompareEqualTo;
  if (key) CFRelease(key);
  if (copy) {
    CFTypeRef modifiers = attribute(element, kAXMenuItemCmdModifiersAttribute);
    int flags = -1;
    if (modifiers && CFGetTypeID(modifiers) == CFNumberGetTypeID())
      CFNumberGetValue((CFNumberRef)modifiers, kCFNumberIntType, &flags);
    if (modifiers) CFRelease(modifiers);
    if (flags == 0) return (AXUIElementRef)CFRetain(element); // Command only, independent of menu language.
  }
  CFTypeRef children = attribute(element, kAXChildrenAttribute);
  AXUIElementRef result = nullptr;
  if (children && CFGetTypeID(children) == CFArrayGetTypeID()) {
    CFArrayRef array = (CFArrayRef)children;
    for (CFIndex i = 0; i < CFArrayGetCount(array) && current(capture); ++i) {
      CFTypeRef child = CFArrayGetValueAtIndex(array, i);
      if (CFGetTypeID(child) != AXUIElementGetTypeID()) continue;
      result = copyMenuItem((AXUIElementRef)child, capture, depth + 1);
      if (result) break;
    }
  }
  if (children) CFRelease(children);
  return result;
}

static bool restoreClipboard(NSPasteboard* board, NSArray<NSPasteboardItem*>* items) {
  [board clearContents];
  return items.count == 0 || [board writeObjects:items];
}

static void copySelection(Capture* capture) {
  if (!current(capture) || !AXIsProcessTrusted()) return;
  AXUIElementRef application = AXUIElementCreateApplication(capture->pid);
  AXUIElementSetMessagingTimeout(application, 0.1);
  CFTypeRef menu = attribute(application, kAXMenuBarAttribute);
  CFRelease(application);
  AXUIElementRef item = menu && CFGetTypeID(menu) == AXUIElementGetTypeID()
    ? copyMenuItem((AXUIElementRef)menu, capture) : nullptr;
  if (menu) CFRelease(menu);
  if (!item) return;
  CFTypeRef enabled = attribute(item, kAXEnabledAttribute);
  bool canCopy = enabled && CFEqual(enabled, kCFBooleanTrue);
  bool disabled = enabled && CFEqual(enabled, kCFBooleanFalse);
  if (enabled) CFRelease(enabled);
  if (!canCopy) {
    if (disabled) capture->status = "ok";
    CFRelease(item);
    return;
  }
  __block NSArray<NSPasteboardItem*>* saved = nil;
  __block NSInteger before = 0;
  dispatch_sync(dispatch_get_main_queue(), ^{
    if (!current(capture) || NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != capture->pid) return;
    NSPasteboard* board = NSPasteboard.generalPasteboard;
    before = board.changeCount;
    NSArray<NSPasteboardItem*>* originals = board.pasteboardItems;
    if (!originals && board.types.count) return;
    NSMutableArray<NSPasteboardItem*>* items = [NSMutableArray array];
    for (NSPasteboardItem* original in originals) {
      NSPasteboardItem* clone = [[NSPasteboardItem alloc] init];
      for (NSPasteboardType type in original.types) {
        NSData* data = [original dataForType:type];
        // Unmaterializable promised data cannot be safely restored: do not Copy.
        if (!data || ![clone setData:data forType:type]) return;
      }
      [items addObject:clone];
    }
    if (board.changeCount == before && current(capture)) saved = items;
  });
  if (!saved || !current(capture)) {
    CFRelease(item);
    return;
  }
  __block bool readyToCopy = false;
  dispatch_sync(dispatch_get_main_queue(), ^{
    readyToCopy = current(capture) && AXIsProcessTrusted() && !IsSecureEventInputEnabled()
      && NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == capture->pid
      && NSPasteboard.generalPasteboard.changeCount == before;
  });
  if (!readyToCopy) {
    CFRelease(item);
    return;
  }
  // AXPress invokes the app's actual standard Copy command, without typing,
  // changing focus, clearing the clipboard first, or needing Apple Events.
  AXUIElementPerformAction(item, kAXPressAction);
  CFRelease(item);
  // Even a timed-out AX action can have copied. Always watch and restore.
  __block bool changed = false;
  do {
    dispatch_sync(dispatch_get_main_queue(), ^{
      NSPasteboard* board = NSPasteboard.generalPasteboard;
      if (board.changeCount == before) return;
      changed = true;
      NSInteger copied = board.changeCount;
      NSString* text = [board stringForType:NSPasteboardTypeString];
      if (board.changeCount != copied) {
        capture->status = "clipboard-changed";
        return; // A newer clipboard owner must not be overwritten.
      }
      bool focused = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == capture->pid;
      if (focused && text) setText(capture, (__bridge CFStringRef)text);
      if (!restoreClipboard(board, saved)) {
        capture->status = "clipboard-restore-failed";
        capture->text.clear();
      }
    });
    if (!changed && Clock::now() < capture->deadline) std::this_thread::sleep_for(std::chrono::milliseconds(15));
  } while (!changed && Clock::now() < capture->deadline);
  // Copy was authorized by positive selection evidence. No change is a failed
  // acquisition, never evidence that the user had no selection.
  if (!changed) capture->status = "unavailable";
}

static void execute(napi_env, void* raw) {
  @autoreleasepool {
    std::lock_guard<std::mutex> lock(captureMutex);
    auto* capture = static_cast<Capture*>(raw);
    if (std::strcmp(capture->status, "secure-input") == 0) return;
    if (!current(capture)) return;
    if (!AXIsProcessTrusted()) {
      capture->status = "accessibility-denied";
      return;
    }
    if (capture->pid <= 0) return;
    AXUIElementRef application = AXUIElementCreateApplication(capture->pid);
    AXUIElementSetMessagingTimeout(application, 0.25);
    CFTypeRef focused = attribute(application, kAXFocusedUIElementAttribute);
    CFRelease(application);
    if (!focused) return;
    if (CFGetTypeID(focused) != AXUIElementGetTypeID()) {
      CFRelease(focused);
      return;
    }
    AXUIElementRef element = (AXUIElementRef)focused;
    AXUIElementSetMessagingTimeout(element, 0.25);
    // Never request a whole control's value. Secure controls are rejected
    // before selected-text reads or invoking the app's standard Copy command.
    AXUIElementRef ancestor = (AXUIElementRef)CFRetain(element);
    bool secure = false;
    bool checkedAncestors = false;
    for (int depth = 0; depth < 16; ++depth) {
      if (!current(capture)) {
        CFRelease(ancestor);
        break;
      }
      AXUIElementSetMessagingTimeout(ancestor, 0.25);
      secure = protectedElement(ancestor);
      CFTypeRef parent = secure ? nullptr : attribute(ancestor, kAXParentAttribute);
      CFRelease(ancestor);
      if (secure || !parent) {
        checkedAncestors = true;
        break;
      }
      if (CFGetTypeID(parent) != AXUIElementGetTypeID()) {
        CFRelease(parent);
        checkedAncestors = true;
        break;
      }
      ancestor = (AXUIElementRef)parent;
      if (depth == 15) CFRelease(ancestor);
    }
    if (secure) capture->status = "secure-input";
    if (secure || !checkedAncestors) {
      CFRelease(element);
      return;
    }
    CFTypeRef selected = nullptr;
    AXError selectedError = AXUIElementCopyAttributeValue(element, kAXSelectedTextAttribute, &selected);
    bool found = setText(capture, selected);
    if (selected) CFRelease(selected);
    bool positiveSelection = false;
    if (!found) {
      CFTypeRef rangeValue = attribute(element, kAXSelectedTextRangeAttribute);
      CFRange range;
      if (rangeValue && CFGetTypeID(rangeValue) == AXValueGetTypeID()
          && AXValueGetType((AXValueRef)rangeValue) == kAXValueTypeCFRange
          && AXValueGetValue((AXValueRef)rangeValue, kAXValueTypeCFRange, &range)) {
        if (range.length == 0) {
          capture->status = "ok";
        } else if (range.location >= 0 && range.length > 0) {
          positiveSelection = true;
          CFTypeRef text = nullptr;
          AXUIElementCopyParameterizedAttributeValue(element, kAXStringForRangeParameterizedAttribute, rangeValue, &text);
          setText(capture, text);
          if (text) CFRelease(text);
        }
      }
      if (rangeValue) CFRelease(rangeValue);
    }
    if (!found && std::strcmp(capture->status, "ok") != 0 && current(capture)) {
      // Browser accessibility implementations can expose opaque text markers
      // instead of UTF-16 ranges. Only query the selected marker range, never
      // the whole document; an absent/unsupported length is not selection proof.
      CFTypeRef markers = attribute(element, CFSTR("AXSelectedTextMarkerRange"));
      if (markers) {
        CFTypeRef lengthValue = nullptr;
        AXUIElementCopyParameterizedAttributeValue(element, CFSTR("AXLengthForTextMarkerRange"), markers, &lengthValue);
        int64_t length = -1;
        if (lengthValue && CFGetTypeID(lengthValue) == CFNumberGetTypeID())
          CFNumberGetValue((CFNumberRef)lengthValue, kCFNumberSInt64Type, &length);
        if (lengthValue) CFRelease(lengthValue);
        if (length == 0) {
          capture->status = "ok";
        } else if (length > 0) {
          positiveSelection = true;
          CFTypeRef text = nullptr;
          AXUIElementCopyParameterizedAttributeValue(element, CFSTR("AXStringForTextMarkerRange"), markers, &text);
          setText(capture, text);
          if (text) CFRelease(text);
        }
        CFRelease(markers);
      }
    }
    if (!found && positiveSelection && std::strcmp(capture->status, "ok") != 0 && current(capture)
        && (selectedError == kAXErrorAttributeUnsupported || selectedError == kAXErrorNoValue))
      copySelection(capture);
    CFRelease(element);
    if (!AXIsProcessTrusted()) {
      capture->status = "accessibility-denied";
      capture->text.clear();
    }
  }
}

static void complete(napi_env env, napi_status status, void* raw) {
  auto* capture = static_cast<Capture*>(raw);
  napi_value result, text, state;
  napi_create_object(env, &result);
  napi_create_string_utf8(env, status == napi_ok ? capture->status : "unavailable", NAPI_AUTO_LENGTH, &state);
  napi_create_string_utf8(env, status == napi_ok ? capture->text.data() : "", status == napi_ok ? capture->text.size() : 0, &text);
  napi_set_named_property(env, result, "status", state);
  napi_set_named_property(env, result, "selectedText", text);
  napi_resolve_deferred(env, capture->deferred, result);
  napi_delete_async_work(env, capture->work);
  delete capture;
}

static napi_value captureSelection(napi_env env, napi_callback_info) {
  if (![NSThread isMainThread]) {
    napi_throw_error(env, nullptr, "Selection capture requires the main thread");
    return nullptr;
  }
  // Pin the source app synchronously, before JS can show/focus the panel.
  auto* capture = new Capture{};
  capture->pid = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
  capture->generation = ++generation;
  capture->deadline = Clock::now() + std::chrono::milliseconds(1800);
  if (IsSecureEventInputEnabled()) capture->status = "secure-input";
  napi_value promise, resource;
  napi_create_promise(env, &capture->deferred, &promise);
  napi_create_string_utf8(env, "cockpitSelectedText", NAPI_AUTO_LENGTH, &resource);
  if (napi_create_async_work(env, nullptr, resource, execute, complete, capture, &capture->work) != napi_ok) {
    delete capture;
    napi_throw_error(env, nullptr, "Selection capture could not start");
    return nullptr;
  }
  if (napi_queue_async_work(env, capture->work) != napi_ok) {
    napi_delete_async_work(env, capture->work);
    delete capture;
    napi_throw_error(env, nullptr, "Selection capture could not start");
    return nullptr;
  }
  return promise;
}

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
    {"capture", nullptr, captureSelection, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}
