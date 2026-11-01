import { untrack } from "svelte";

// SvelteMap/SvelteSet lookups of absent keys depend on every insert and delete, so one file
// turning hot re-ran every cold file's lookups. Lookups here depend on one slot signal picked by
// key; the signals are created up front because state created inside a reaction isn't tracked by it.
const SLOTS = 512;

class Signal {
  version = $state(0);
}

function bump(signal) {
  signal.version = untrack(() => signal.version) + 1;
}

function hashSlot(key) {
  const text = String(key);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return (hash >>> 0) % SLOTS;
}

export class KeyedMap {
  #entries = new Map();
  #signals = Array.from({ length: SLOTS }, () => new Signal());
  #any = new Signal();
  #objectSlots = new WeakMap();
  #nextSlot = 0;

  #signal(key) {
    if ((typeof key !== "object" || key === null) && typeof key !== "function") return this.#signals[hashSlot(key)];
    let slot = this.#objectSlots.get(key);
    if (slot === undefined) {
      slot = this.#nextSlot++ % SLOTS;
      this.#objectSlots.set(key, slot);
    }
    return this.#signals[slot];
  }

  get(key) {
    this.#signal(key).version;
    return this.#entries.get(key);
  }

  has(key) {
    this.#signal(key).version;
    return this.#entries.has(key);
  }

  set(key, value) {
    if (this.#entries.has(key) && this.#entries.get(key) === value) return this;
    this.#entries.set(key, value);
    bump(this.#signal(key));
    bump(this.#any);
    return this;
  }

  delete(key) {
    if (!this.#entries.delete(key)) return false;
    bump(this.#signal(key));
    bump(this.#any);
    return true;
  }

  clear() {
    if (this.#entries.size === 0) return;
    const signals = new Set();
    for (const key of this.#entries.keys()) signals.add(this.#signal(key));
    this.#entries.clear();
    for (const signal of signals) bump(signal);
    bump(this.#any);
  }

  get size() {
    this.#any.version;
    return this.#entries.size;
  }

  keys() {
    this.#any.version;
    return this.#entries.keys();
  }

  entries() {
    this.#any.version;
    return this.#entries.entries();
  }

  [Symbol.iterator]() {
    return this.entries();
  }
}

export class KeyedSet {
  #map = new KeyedMap();

  has(key) {
    return this.#map.has(key);
  }

  add(key) {
    this.#map.set(key, true);
    return this;
  }

  delete(key) {
    return this.#map.delete(key);
  }

  clear() {
    this.#map.clear();
  }

  get size() {
    return this.#map.size;
  }

  [Symbol.iterator]() {
    return this.#map.keys();
  }
}
