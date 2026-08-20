// True while a ShortcutInput is recording, so global key handlers yield the keys to it.
let recording = false;
export const isRecordingShortcut = () => recording;
export const setRecordingShortcut = (v) => (recording = v);
