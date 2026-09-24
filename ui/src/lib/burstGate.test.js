import { expect, test } from "bun:test";
import { burstGate } from "./burstGate.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("runs the first trigger at once and folds a burst into one trailing run", async () => {
  let runs = 0;
  const gate = burstGate(() => runs++, 40);
  gate.trigger();
  expect(runs).toBe(1);
  for (let i = 0; i < 5; i++) gate.trigger();
  expect(runs).toBe(1);
  await wait(60);
  expect(runs).toBe(2);
  await wait(60);
  expect(runs).toBe(2);
});

test("a quiet window reopens the gate for an immediate run", async () => {
  let runs = 0;
  const gate = burstGate(() => runs++, 20);
  gate.trigger();
  await wait(50);
  gate.trigger();
  expect(runs).toBe(2);
  gate.cancel();
});

test("cancel drops a pending trailing run", async () => {
  let runs = 0;
  const gate = burstGate(() => runs++, 20);
  gate.trigger();
  gate.trigger();
  gate.cancel();
  await wait(40);
  expect(runs).toBe(1);
});
