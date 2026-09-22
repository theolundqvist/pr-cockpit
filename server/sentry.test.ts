import { expect, test } from "bun:test";
import { sentryEnvironment } from "./sentry.ts";

test("Sentry separates managed, development, and test processes", () => {
  const supervisor = Bun.env.COCKPIT_SUPERVISOR;
  const nodeEnv = Bun.env.NODE_ENV;
  const mock = Bun.env.COCKPIT_MOCK;
  try {
    delete Bun.env.COCKPIT_SUPERVISOR;
    delete Bun.env.NODE_ENV;
    delete Bun.env.COCKPIT_MOCK;
    expect(sentryEnvironment()).toBe("development");

    Bun.env.COCKPIT_SUPERVISOR = "launchd";
    expect(sentryEnvironment()).toBe("production");

    Bun.env.NODE_ENV = "test";
    expect(sentryEnvironment()).toBe("test");
  } finally {
    if (supervisor === undefined) delete Bun.env.COCKPIT_SUPERVISOR;
    else Bun.env.COCKPIT_SUPERVISOR = supervisor;
    if (nodeEnv === undefined) delete Bun.env.NODE_ENV;
    else Bun.env.NODE_ENV = nodeEnv;
    if (mock === undefined) delete Bun.env.COCKPIT_MOCK;
    else Bun.env.COCKPIT_MOCK = mock;
  }
});
