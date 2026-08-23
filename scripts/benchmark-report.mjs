// Renders docs/BENCHMARKS.md from the measured samples in docs/benchmark-results.js.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCTS = [
  ["cockpit", "PR Cockpit"],
  ["github", "GitHub"],
  ["cursorOrigin", "Cursor Origin"],
];

function percentile(sorted, q) {
  const rank = Math.ceil((q / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
}

const ms = (value) => value.toFixed(1);

function summaryRow(name, samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((total, value) => total + value, 0) / sorted.length;
  return `| ${name} | ${sorted.length} | ${ms(sorted[0])} | ${ms(percentile(sorted, 50))} | ${ms(percentile(sorted, 90))} | ${ms(percentile(sorted, 95))} | ${ms(percentile(sorted, 99))} | ${ms(sorted.at(-1))} | ${ms(mean)} |`;
}

function section(metric, ...notes) {
  const lines = [`## ${metric.label}`, ""];
  for (const note of notes.filter(Boolean)) lines.push(note, "");
  lines.push(
    "| Product | Runs | min | p50 | p90 | p95 | p99 | max | mean |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  const measured = [];
  for (const [key, name] of PRODUCTS) {
    const product = metric[key];
    if (!product?.samples) {
      lines.push(`| ${name} | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |`);
      continue;
    }
    measured.push([name, product]);
    lines.push(summaryRow(name, product.samples));
  }
  const unavailable = PRODUCTS.map(([key, name]) => [name, metric[key]]).filter(
    ([, product]) => product && product.available === false && product.reason,
  );
  for (const [name, product] of unavailable) lines.push("", `${name}: ${product.reason}`);

  lines.push("", "### Every run in milliseconds", "");
  for (const [name, product] of measured) lines.push(`${name}: ${product.definition}`, "");
  lines.push(
    `| Run | ${measured.map(([name]) => name).join(" | ")} |`,
    `| --- | ${measured.map(() => "---").join(" | ")} |`,
  );
  const runs = Math.max(...measured.map(([, product]) => product.samples.length));
  for (let run = 0; run < runs; run++) {
    const cells = measured.map(([, product]) => {
      const sample = product.samples[run];
      return sample === undefined ? "" : ms(sample);
    });
    lines.push(`| ${run + 1} | ${cells.join(" | ")} |`);
  }
  return [...lines, ""].join("\n");
}

function environment(title, env) {
  const lines = [`### ${title}`, "", "| Field | Value |", "| --- | --- |"];
  for (const [field, value] of Object.entries(env)) {
    if (value && typeof value === "object") continue;
    lines.push(`| ${field} | ${String(value).replaceAll("|", "\\|")} |`);
  }
  return [...lines, ""].join("\n");
}

const source = await readFile(join(ROOT, "docs/benchmark-results.js"), "utf8");
const data = JSON.parse(source.slice(source.indexOf("=") + 1).trim().replace(/;$/, ""));

const document = [
  "# PR Cockpit benchmark results",
  "",
  `Every measured sample behind the landing-page comparison, measured ${data.measuredAt}. Reproduce with [scripts/benchmark-ui.mjs](../scripts/benchmark-ui.mjs); regenerate this file with \`node scripts/benchmark-report.mjs\`.`,
  "",
  ...data.metrics.map((metric) => section(metric)),
  section(data.renderBenchmark, data.renderEnvironment.dataset, data.renderBenchmark.boundary),
  "## Environments",
  "",
  environment("Pull-request and diff opens", data.environment),
  environment("Search", data.searchEnvironment),
  environment("Cursor Origin", data.cursorOriginEnvironment),
  environment("Huge pull request render", data.renderEnvironment),
].join("\n");

await writeFile(join(ROOT, "docs/BENCHMARKS.md"), `${document}\n`);
console.log("wrote docs/BENCHMARKS.md");
