import { parseDiff } from "./diff.js";

export function createDiffDocument(text, indexedFiles, worker = null) {
  const indexed = new Map(indexedFiles.map((file) => [file.path, file]));
  const current = new Map(indexed);
  const generations = new Map();
  const pending = new Map();
  const prefetching = new Map();
  let requestId = 0;

  if (worker) {
    worker.onmessage = ({ data }) => {
      if (data.type !== "file") return;
      const request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      request.resolve(data.file);
    };
    worker.onerror = (event) => {
      const error = event.error ?? new Error(event.message);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    };
  }
  function storeHydrated(file) {
    const original = indexed.get(file?.path);
    if (!original) return original;
    file.fingerprint = original.fingerprint;
    file.patchStart = original.patchStart;
    file.patchEnd = original.patchEnd;
    file.hydrated = true;
    current.set(file.path, file);
    return file;
  }

  return {
    files: indexedFiles,
    hydrate(path) {
      const file = current.get(path);
      if (!file || file.hydrated) return file;
      return storeHydrated(parseDiff(text.slice(file.patchStart, file.patchEnd))[0]);
    },
    prefetch(path) {
      const file = current.get(path);
      if (!file || file.hydrated) return Promise.resolve(file);
      if (prefetching.has(path)) return prefetching.get(path);
      if (!worker) return Promise.resolve(this.hydrate(path));
      const generation = generations.get(path) ?? 0;
      const id = ++requestId;
      const promise = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ type: "hydrate", id, path });
      }).then((hydrated) => {
        if ((generations.get(path) ?? 0) !== generation) return null;
        return current.get(path)?.hydrated ? current.get(path) : storeHydrated(hydrated);
      });
      prefetching.set(path, promise);
      const clear = () => {
        if (prefetching.get(path) === promise) prefetching.delete(path);
      };
      promise.then(clear, clear);
      return promise;
    },
    release(path) {
      prefetching.delete(path);
      generations.set(path, (generations.get(path) ?? 0) + 1);
      const original = indexed.get(path);
      if (original) current.set(path, original);
      return original;
    },
    dispose() {
      worker?.terminate();
      for (const request of pending.values()) request.resolve(null);
      pending.clear();
    },
  };
}

export function loadDiffDocument(bytes) {
  if (bytes.byteLength === 0) return Promise.resolve(createDiffDocument("", []));
  const worker = new Worker(new URL("./diff.worker.js", import.meta.url), { type: "module" });
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      const text = new TextDecoder().decode(data.bytes);
      resolve(createDiffDocument(text, data.files, worker));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(event.error ?? new Error(event.message));
    };
    worker.postMessage({ type: "index", bytes }, [bytes]);
  });
}
