import { indexDiff, parseDiff } from "./diff.js";

const decoder = new TextDecoder();
let bytes = new Uint8Array();

self.onmessage = ({ data }) => {
  if (data.type === "load") {
    bytes = data.bytes;
    if (data.index) self.postMessage({ type: "index", files: indexDiff(decoder.decode(bytes)) });
    return;
  }

  const file = parseDiff(decoder.decode(bytes.subarray(data.byteStart, data.byteEnd)))[0];
  self.postMessage({ type: "file", id: data.id, file });
};
