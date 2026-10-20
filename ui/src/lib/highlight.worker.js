import { tokenizeRequest } from "./highlight.js";

self.onmessage = async ({ data: { id, ...request } }) => {
  try {
    self.postMessage({ id, result: await tokenizeRequest(request) });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
