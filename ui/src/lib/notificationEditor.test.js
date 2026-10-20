import { describe, expect, test } from "bun:test";
import { parseNotificationSettings } from "../../../shared/notificationRules.ts";
import {
  NOTIFICATION_EXAMPLES,
  newNotificationCondition,
  newNotificationRule,
  notificationRuleIssues,
  retargetNotificationCondition,
  serializeNotificationSettings,
} from "./notificationEditor.js";

describe("notification rule editor", () => {
  test("flags rules the server would reject, in the order the user fixes them", () => {
    const unnamed = newNotificationRule({ events: ["comment"] });
    const eventless = newNotificationRule({ name: "Silent" });
    const blank = newNotificationRule({ name: "Blank", events: ["review"], conditions: [{ field: "body", operator: "contains", value: "   " }] });
    const fine = newNotificationRule({ name: "Fine", events: ["merged"] });
    const issues = notificationRuleIssues([unnamed, eventless, blank, fine]);
    expect(issues.get(unnamed.id)).toMatch(/name/);
    expect(issues.get(eventless.id)).toMatch(/event/);
    expect(issues.get(blank.id)).toMatch(/condition/);
    expect(issues.has(fine.id)).toBe(false);
  });

  test("examples serialize into settings the server accepts, with the master switch untouched", () => {
    const fill = (rule) => ({ ...rule, conditions: rule.conditions.map((condition) => condition.value ? condition : { ...condition, value: condition.field === "branch" ? "main" : "Deploy" }) });
    const rules = NOTIFICATION_EXAMPLES.map((example) => example.build("octocat"));
    expect([...notificationRuleIssues(rules).keys()]).toEqual([rules[2].id]);
    const parsed = parseNotificationSettings(serializeNotificationSettings({ enabled: false, rules: rules.map(fill) }));
    expect(parsed.enabled).toBe(false);
    expect(parsed.rules.map((rule) => rule.events)).toEqual([["comment"], ["review_requested"], ["deployed"]]);
    expect(parsed.rules[0].conditions).toContainEqual({ field: "body", operator: "contains", value: "@octocat" });
    expect(parsed.rules[2].conditions).toEqual([
      { field: "participation", operator: "is", value: "author" },
      { field: "workflow", operator: "is", value: "Deploy" },
      { field: "branch", operator: "is", value: "main" },
    ]);
  });

  test("the mention example needs a login before it can be saved", () => {
    const rule = NOTIFICATION_EXAMPLES[0].build(null);
    expect(notificationRuleIssues([rule]).has(rule.id)).toBe(true);
  });

  test("serialization trims text the user typed but keeps ids and ordering", () => {
    const rule = newNotificationRule({ name: "  Spaced  ", events: ["comment", "review"], match: "any", conditions: [{ field: "title", operator: "contains", value: " hotfix " }] });
    const out = serializeNotificationSettings({ enabled: true, rules: [rule] });
    expect(out.rules[0]).toEqual({ id: rule.id, name: "Spaced", enabled: true, events: ["comment", "review"], match: "any", conditions: [{ field: "title", operator: "contains", value: "hotfix" }] });
    expect(() => parseNotificationSettings(out)).not.toThrow();
  });

  test("switching a condition's field keeps a compatible operator and resets the value to a valid option", () => {
    const text = { field: "body", operator: "notContains", value: "wip" };
    expect(retargetNotificationCondition(text, "actorType")).toEqual({ field: "actorType", operator: "is", value: "human" });
    const negated = { field: "actor", operator: "isNot", value: "$me" };
    expect(retargetNotificationCondition(negated, "repository")).toEqual({ field: "repository", operator: "isNot", value: "" });
    expect(retargetNotificationCondition(negated, "actor")).toBe(negated);
    expect(newNotificationCondition("isDraft")).toEqual({ field: "isDraft", operator: "is", value: "true" });
  });
});
