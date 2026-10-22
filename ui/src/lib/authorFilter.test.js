import { expect, test } from "bun:test";
import { availableAuthors, filterByAuthorAndDraft } from "./authorFilter.js";

const prs = [
  { author: "ada", title: "feat: ready" },
  { author: "Bob", title: "fix: wip", isDraft: true },
  { author: "bob", title: "DRAFT docs: notes" },
];

test("hides drafts and narrows to an author", () => {
  expect(filterByAuthorAndDraft(prs, { author: "all", hideDrafts: false }, "ada")).toBe(prs);
  expect(filterByAuthorAndDraft(prs, { author: "all", hideDrafts: true }, "ada")).toEqual([prs[0]]);
  expect(filterByAuthorAndDraft(prs, { author: "me", hideDrafts: false }, "ADA")).toEqual([prs[0]]);
  expect(filterByAuthorAndDraft(prs, { author: "me", hideDrafts: false }, null)).toEqual([]);
  expect(filterByAuthorAndDraft(prs, { author: "bob", hideDrafts: false }, "ada")).toEqual([prs[1], prs[2]]);
  expect(availableAuthors(prs, [{ author: "carol" }])).toEqual(["ada", "Bob", "bob", "carol"]);
});
