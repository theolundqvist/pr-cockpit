window.PR_COCKPIT_BENCHMARKS = {
  "measuredAt": "2026-08-20T16:14:17.983Z",
  "environment": {
    "machine": "Apple M4 Max",
    "browser": "Chromium 149.0.7827.55",
    "viewport": "1100×800",
    "runs": 50,
    "warmups": 5,
    "dataset": "15 public microsoft/vscode PRs"
  },
  "metrics": [
    {
      "id": "pr-open",
      "label": "Open cached PR",
      "definition": "Inbox click to painted PR detail",
      "unit": "ms",
      "p50": 19,
      "p95": 35.9
    },
    {
      "id": "pr-search",
      "label": "Search recent PRs",
      "definition": "⌘K to painted local title match",
      "unit": "ms",
      "p50": 30.8,
      "p95": 33.7
    },
    {
      "id": "diff-open",
      "label": "Open cached diff",
      "definition": "Files click to painted cached diff",
      "unit": "ms",
      "p50": 26.8,
      "p95": 65.5
    }
  ]
};
