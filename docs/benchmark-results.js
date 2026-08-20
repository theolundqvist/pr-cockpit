window.PR_COCKPIT_BENCHMARKS = {
  "measuredAt": "2026-08-20T17:22:53.295Z",
  "environment": {
    "machine": "Apple M4 Max",
    "browser": "Chromium 149.0.7827.55",
    "viewport": "1100×800",
    "runs": 20,
    "warmups": 3,
    "dataset": "15 public microsoft/vscode PRs",
    "cache": "Warm browser cache for both products; PR Cockpit reads its local disk cache while GitHub uses the current network connection"
  },
  "metrics": [
    {
      "id": "pr-open",
      "label": "Open a PR",
      "cockpit": {
        "unit": "ms",
        "p50": 18.9,
        "p95": 27.3,
        "definition": "Inbox row to painted PR detail"
      },
      "github": {
        "unit": "ms",
        "p50": 1158,
        "p95": 1566,
        "definition": "Pull-request result to painted PR detail"
      },
      "speedup": 61.3
    },
    {
      "id": "pr-search",
      "label": "Search PRs",
      "cockpit": {
        "unit": "ms",
        "p50": 31.2,
        "p95": 32.8,
        "definition": "⌘K PR-number query to painted local result"
      },
      "github": {
        "unit": "ms",
        "p50": 500.5,
        "p95": 683.6,
        "definition": "Pull-request number query submit to painted result"
      },
      "speedup": 16
    },
    {
      "id": "diff-open",
      "label": "Open a diff",
      "cockpit": {
        "unit": "ms",
        "p50": 36.2,
        "p95": 83,
        "definition": "Files click to painted cached diff"
      },
      "github": {
        "unit": "ms",
        "p50": 1417.6,
        "p95": 1887,
        "definition": "Files changed click to painted GitHub diff"
      },
      "speedup": 39.2
    }
  ]
};
