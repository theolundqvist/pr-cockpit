#import <AppKit/AppKit.h>
#include <node_api.h>
#include <cstring>

struct Phase { const char* name; NSInteger window; };
static id monitor = nil;
static napi_threadsafe_function callback = nullptr;

static void deliver(napi_env env, napi_value function, void*, void* raw) {
  auto* phase = static_cast<Phase*>(raw);
  if (env && function) {
    napi_value args[2], receiver;
    napi_get_undefined(env, &receiver);
    napi_create_string_utf8(env, phase->name, NAPI_AUTO_LENGTH, &args[0]);
    napi_create_int64(env, phase->window, &args[1]);
    napi_call_function(env, receiver, function, 2, args, nullptr);
  }
  delete phase;
}

// Finger contact has its own phase. Momentum events have phase=None and must never
// extend a held gesture or start another navigation after the fingers have lifted.
static void dispatchPhase(NSEventPhase phase, bool precise, NSInteger window) {
  if (!callback || !precise) return;
  const char* name = nullptr;
  if (phase & NSEventPhaseCancelled) name = "cancel";
  else if (phase & NSEventPhaseEnded) name = "end";
  else if (phase & (NSEventPhaseBegan | NSEventPhaseMayBegin)) name = "begin";
  if (!name) return;
  auto* message = new Phase{name, window};
  if (napi_call_threadsafe_function(callback, message, napi_tsfn_nonblocking) != napi_ok) delete message;
}

static void cleanup(void*) {
  if (monitor) { [NSEvent removeMonitor:monitor]; monitor = nil; }
  if (callback) { napi_release_threadsafe_function(callback, napi_tsfn_abort); callback = nullptr; }
}

static napi_value start(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value function, resource, result;
  napi_get_cb_info(env, info, &count, &function, nullptr, nullptr);
  napi_valuetype type;
  if (count != 1 || napi_typeof(env, function, &type) != napi_ok || type != napi_function || ![NSThread isMainThread]) {
    napi_throw_type_error(env, nullptr, "start requires a callback on the main thread");
    return nullptr;
  }
  if (!callback) {
    napi_create_string_utf8(env, "trackpadFingerPhase", NAPI_AUTO_LENGTH, &resource);
    if (napi_create_threadsafe_function(env, function, nullptr, resource, 0, 1, nullptr, nullptr, nullptr, deliver, &callback) != napi_ok) return nullptr;
    napi_unref_threadsafe_function(env, callback);
    monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskScrollWheel handler:^NSEvent*(NSEvent* event) {
      dispatchPhase(event.phase, event.hasPreciseScrollingDeltas, event.window.windowNumber);
      return event;
    }];
    napi_add_env_cleanup_hook(env, cleanup, nullptr);
  }
  napi_get_boolean(env, monitor != nil, &result);
  return result;
}

static napi_value windowNumber(napi_env env, napi_callback_info info) {
  size_t count = 1, length = 0;
  napi_value handle, result;
  void* data = nullptr;
  napi_get_cb_info(env, info, &count, &handle, nullptr, nullptr);
  bool isBuffer = false;
  if (count != 1 || napi_is_buffer(env, handle, &isBuffer) != napi_ok || !isBuffer
      || napi_get_buffer_info(env, handle, &data, &length) != napi_ok || length != sizeof(void*)) {
    napi_throw_type_error(env, nullptr, "expected a native window handle");
    return nullptr;
  }
  void* pointer;
  std::memcpy(&pointer, data, sizeof(pointer));
  NSView* view = (__bridge NSView*)pointer;
  napi_create_int64(env, view.window.windowNumber, &result);
  return result;
}

#ifdef TRACKPAD_TESTING
// Test builds replay AppKit phase bitmasks through the same native callback queue.
static napi_value replay(napi_env env, napi_callback_info info) {
  size_t count = 3;
  napi_value args[3], result;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  uint32_t phase = 0; int64_t window = 0; bool precise = true;
  napi_get_value_uint32(env, args[0], &phase);
  napi_get_value_int64(env, args[1], &window);
  napi_get_value_bool(env, args[2], &precise);
  dispatchPhase(static_cast<NSEventPhase>(phase), precise, window);
  napi_get_undefined(env, &result);
  return result;
}
#endif

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
    {"start", nullptr, start, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"windowNumber", nullptr, windowNumber, nullptr, nullptr, nullptr, napi_default, nullptr},
#ifdef TRACKPAD_TESTING
    {"replay", nullptr, replay, nullptr, nullptr, nullptr, napi_default, nullptr},
#endif
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}
