window.PR_COCKPIT_BENCHMARKS = {
  "measuredAt": "2026-08-20T17:03:52.892Z",
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
        "p50": 17.4,
        "p95": 24.8,
        "definition": "Inbox row to painted PR detail"
      },
      "github": {
        "unit": "ms",
        "p50": 1013.6,
        "p95": 1778.8,
        "definition": "Pull-request result to painted PR detail"
      },
      "speedup": 58.3
    },
    {
      "id": "pr-search",
      "label": "Search PRs",
      "cockpit": {
        "unit": "ms",
        "p50": 30.6,
        "p95": 32,
        "definition": "⌘K PR-number query to painted local result"
      },
      "github": {
        "unit": "ms",
        "p50": 497.4,
        "p95": 631.3,
        "definition": "Pull-request number query submit to painted result"
      },
      "speedup": 16.3
    },
    {
      "id": "diff-open",
      "label": "Open a diff",
      "cockpit": {
        "unit": "ms",
        "p50": 38.3,
        "p95": 86.2,
        "definition": "Files click to painted cached diff"
      },
      "github": {
        "unit": "ms",
        "p50": 1524.3,
        "p95": 2716.1,
        "definition": "Files changed click to painted GitHub diff"
      },
      "speedup": 39.8
    }
  ]
};
