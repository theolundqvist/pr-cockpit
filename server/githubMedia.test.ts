import { expect, test } from "bun:test";
import { extractGithubMedia } from "./githubMedia.ts";

const asset = (id: string) => `https://github.com/user-attachments/assets/${id}`;

const body = [
  "## Explainer",
  `<img width="600" src="${asset("0000aaaa-0000-0000-0000-000000000001")}" alt="flow">`,
  `![slide-01.png](${asset("0000aaaa-0000-0000-0000-000000000002")})`,
  "",
  `  ${asset("0000aaaa-0000-0000-0000-000000000003")}  `,
  "",
  `See the recording at ${asset("0000aaaa-0000-0000-0000-000000000009")} for context.`,
  `<video src="${asset("0000aaaa-0000-0000-0000-000000000004")}"></video>`,
  "![external](https://example.com/chart.png)",
  `![again](${asset("0000aaaa-0000-0000-0000-000000000002")})`,
  "![raw](https://raw.githubusercontent.com/acme/app/main/chart.gif)",
  "```md",
  `![in code](${asset("0000aaaa-0000-0000-0000-000000000005")})`,
  "```",
  `<!-- ![template](${asset("0000aaaa-0000-0000-0000-000000000006")}) -->`,
].join("\n");

test("media keeps document order across markdown, HTML, and bare video attachments", () => {
  expect(extractGithubMedia(body, { videos: true })).toEqual([
    asset("0000aaaa-0000-0000-0000-000000000001"),
    asset("0000aaaa-0000-0000-0000-000000000002"),
    asset("0000aaaa-0000-0000-0000-000000000003"),
    asset("0000aaaa-0000-0000-0000-000000000004"),
    "https://raw.githubusercontent.com/acme/app/main/chart.gif",
  ]);
});

test("image-only extraction skips videos, and hidden or foreign media never counts", () => {
  expect(extractGithubMedia(body, { videos: false })).toEqual([
    asset("0000aaaa-0000-0000-0000-000000000001"),
    asset("0000aaaa-0000-0000-0000-000000000002"),
    "https://raw.githubusercontent.com/acme/app/main/chart.gif",
  ]);
  expect(extractGithubMedia("", { videos: true })).toEqual([]);
});
