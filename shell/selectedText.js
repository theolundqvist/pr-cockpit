const ACCESSIBILITY_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

function selectionFailure(status) {
  if (status === "accessibility-denied") return {
    message: "Allow Accessibility to capture selected text",
    detail: "Open System Settings → Privacy & Security → Accessibility and enable PR Cockpit (or the Electron app running this instance). Automation permission is not needed. You can still enter a prompt manually.",
    settings: ACCESSIBILITY_SETTINGS,
  };
  if (status === "secure-input") return {
    message: "Protected text was not captured",
    detail: "Quick Generate does not read password fields or capture while macOS Secure Input is active. You can enter a prompt manually.",
  };
  if (status === "clipboard-restore-failed") return {
    message: "The clipboard could not be restored",
    detail: "The source app copied its selection, but macOS rejected restoring the previous clipboard contents. No text was imported. You can enter a prompt manually.",
  };
  return {
    message: "Selected text could not be captured",
    detail: status === "native-unavailable"
      ? "The macOS selection helper is unavailable. Reinstall or update PR Cockpit to build its native helper, then relaunch when convenient. You can enter a prompt manually."
      : "The source app did not expose a readable selection or a usable standard Copy command, or did not respond in time. Select text and copy/paste it manually. Your existing prompt has been kept.",
  };
}

function createSelectionCapture({ platform = process.platform, loadNative = () => require("./native/build/selected-text.node"), timeoutMs = 3000 } = {}) {
  let native;
  return async () => {
    // Preserve existing non-Mac behavior: do not read an unrelated clipboard.
    if (platform !== "darwin") return { status: "ok", selectedText: "" };
    try {
      native ||= loadNative();
    } catch {
      return { status: "native-unavailable", selectedText: "" };
    }
    let timer;
    try {
      const result = await Promise.race([
        native.capture(),
        new Promise((resolve) => { timer = setTimeout(() => resolve({ status: "unavailable", selectedText: "" }), timeoutMs); }),
      ]);
      if (!result || typeof result.status !== "string" || typeof result.selectedText !== "string") {
        return { status: "unavailable", selectedText: "" };
      }
      return result.status === "ok" ? result : { status: result.status, selectedText: "" };
    } catch {
      return { status: "unavailable", selectedText: "" };
    } finally {
      clearTimeout(timer);
    }
  };
}

function createSelectionOpener({ getPanel, capture, reportFailure }) {
  let generation = 0;
  return {
    cancel() { generation++; },
    async open() {
      const request = ++generation;
      const panel = getPanel();
      if (!panel) return;
      // A floating panel can be visible while another app owns the selection.
      // Only a focused panel toggles closed; visibility alone must not skip capture.
      if (panel.win.isFocused()) {
        panel.hide();
        return;
      }
      // An older result queued while the renderer loads must not present midway
      // through the next capture and steal focus from its source app.
      panel.cancelPendingShow();
      let result;
      try {
        result = await capture();
      } catch {
        result = { status: "unavailable", selectedText: "" };
      }
      if (request !== generation || getPanel() !== panel) return;
      const detail = { selectedText: result.status === "ok" ? result.selectedText : "" };
      const failure = result.status === "ok" ? null : selectionFailure(result.status);
      const actionable = failure && (failure.settings || result.status === "clipboard-restore-failed");
      if (failure && !actionable) detail.captureError = `${failure.message}. ${failure.detail}`;
      panel.show(detail);
      if (actionable) reportFailure(failure, panel);
    },
  };
}

module.exports = { createSelectionCapture, createSelectionOpener, selectionFailure };
