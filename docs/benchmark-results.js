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
  ],
  "cursorOrigin": {
    "measuredAt": "2026-08-21T09:29:04.442Z",
    "environment": {
      "machine": "Apple M4 Max",
      "browser": "Chrome/152.0.7929.0",
      "viewport": "1100×800",
      "runs": 20,
      "warmups": 3,
      "dataset": "Authenticated scape-app/scape staging; representative PR #8110",
      "cache": "Warm authenticated browser profile and HTTP cache; cache is not cleared between warmups or measured runs",
      "sourceURL": "https://cursor.com/codebase/scape/scape/tree/staging"
    },
    "selectors": {
      "listStart": "visible a[href$=\"/pulls\"]",
      "listFirstUseful": "[data-testid=\"cursor-review-pulls-page\"] plus first visible a[class*=\"rowTitleLink\"]",
      "listFull": "rendered rowTitleLink count equals the visible Open count, with no visible progressbar or animate-spin",
      "detailStart": "visible a[href$=\"/github/pull/8110\"]",
      "detailFirstUseful": "[data-testid=\"cursor-review-pr-shell\"] plus visible h1 aria-label containing #8110",
      "detailComplete": "[data-testid=\"timeline-activity-group\"] with content plus visible [data-testid=\"merge-box\"], with no visible progressbar or animate-spin"
    },
    "metrics": [
      {
        "id": "pr-list-first-useful",
        "label": "PR list first useful paint",
        "unit": "s",
        "p50": 1.146,
        "p95": 1.957,
        "definition": "Pull Requests navigation to first painted PR row",
        "samples": [
          1.083,
          0.929,
          1.016,
          1.201,
          1.146,
          1.028,
          1.075,
          0.925,
          1.257,
          0.963,
          1.628,
          1.189,
          1,
          2.673,
          1.32,
          0.881,
          1.957,
          1.63,
          1.531,
          1.765
        ]
      },
      {
        "id": "pr-list-full",
        "label": "PR list full render",
        "unit": "s",
        "p50": 1.146,
        "p95": 1.957,
        "definition": "Pull Requests navigation to all Open rows painted",
        "samples": [
          1.083,
          0.929,
          1.016,
          1.201,
          1.146,
          1.029,
          1.075,
          0.925,
          1.257,
          0.963,
          1.628,
          1.189,
          1,
          2.673,
          1.32,
          0.881,
          1.957,
          1.631,
          1.531,
          1.766
        ]
      },
      {
        "id": "pr-detail-first-useful",
        "label": "PR detail first useful paint",
        "unit": "s",
        "p50": 1.317,
        "p95": 1.976,
        "definition": "PR #8110 click to painted detail shell and heading",
        "samples": [
          1.373,
          1.976,
          1.158,
          1.33,
          1.377,
          1.255,
          1.32,
          1.287,
          1.704,
          1.259,
          1.318,
          1.407,
          1.241,
          1.2,
          1.308,
          1.759,
          2.141,
          1.317,
          1.048,
          1.263
        ]
      },
      {
        "id": "pr-detail-complete",
        "label": "PR detail complete render",
        "unit": "s",
        "p50": 1.317,
        "p95": 1.976,
        "definition": "PR #8110 click to painted activity timeline and merge box",
        "samples": [
          1.373,
          1.976,
          1.158,
          1.33,
          1.377,
          1.255,
          1.32,
          1.287,
          1.704,
          1.259,
          1.318,
          1.407,
          1.241,
          1.2,
          1.308,
          1.759,
          2.141,
          1.317,
          1.048,
          1.263
        ]
      }
    ]
  }
};
