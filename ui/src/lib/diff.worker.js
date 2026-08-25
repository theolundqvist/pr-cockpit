import { indexDiff, parseDiff } from "./diff.js";

let text = "";
let indexedByPath = new Map();

self.onmessage = ({ data }) => {
  if (data.type === "index") {
    text = new TextDecoder().decode(data.bytes);
    const files = indexDiff(text);
    indexedByPath = new Map(files.map((file) => [file.path, file]));
    self.postMessage({ type: "index", bytes: data.bytes, files }, [data.bytes]);
    return;
  }

  const indexed = indexedByPath.get(data.path);
  const file = parseDiff(text.slice(indexed.patchStart, indexed.patchEnd))[0];
  self.postMessage({ type: "file", id: data.id, file });
};
