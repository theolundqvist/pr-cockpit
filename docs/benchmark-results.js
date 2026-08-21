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
      "speedup": 61.3,
      "cursorOrigin": {
        "available": true,
        "unit": "ms",
        "p50": 1176.7,
        "p95": 1502.7,
        "definition": "Origin PR #8105 list row to first painted PR detail",
        "samples": [
          1126.4,
          1207.5,
          1094.9,
          1290.5,
          1166.8,
          891,
          1502.7,
          1081.3,
          1176.7,
          1134.7,
          1287.4,
          1384.4,
          1412.2,
          1285.7,
          1033.6,
          1457.6,
          1148.4,
          1193.5,
          1085.2,
          1512.9
        ]
      }
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
      "speedup": 16,
      "cursorOrigin": {
        "available": false,
        "reason": "Cursor Origin exposes PR filters but no comparable PR-number search interaction"
      }
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
      "speedup": 39.2,
      "cursorOrigin": {
        "available": true,
        "unit": "ms",
        "p50": 924.9,
        "p95": 1384.3,
        "definition": "Origin PR #8105 Changes tab to first painted diff line",
        "samples": [
          589.8,
          650.6,
          634.3,
          928.8,
          978.5,
          753.3,
          924.9,
          864.7,
          789.7,
          794.3,
          923.8,
          1245.2,
          1480.4,
          1108.3,
          1090.3,
          1309.2,
          1384.3,
          815.8,
          1180.5,
          1245
        ]
      }
    }
  ],
  "cursorOriginEnvironment": {
    "measuredAt": "2026-08-21T10:33:01.925Z",
    "machine": "Apple M4 Max",
    "browser": "Chrome/152.0.7929.0",
    "viewport": "1100×800",
    "runs": 20,
    "warmups": 3,
    "auth": "Authenticated isolated Chromium profile",
    "dataset": "scape-app/scape staging; representative open PR #8105",
    "cache": "Warm authenticated browser profile and HTTP cache; cache is not cleared between warmups or measured runs",
    "sourceURL": "https://cursor.com/codebase/scape/scape/tree/staging",
    "cdp": "http://127.0.0.1:9334",
    "paintBoundary": "Visible selector followed by two requestAnimationFrame callbacks",
    "selectors": {
      "openStart": "visible PR-list a[href$=\"/github/pull/8105\"]",
      "openPainted": "[data-testid=\"cursor-review-pr-shell\"] plus visible h1 aria-label containing #8105",
      "diffStart": "visible [role=\"tab\"] whose text starts with Changes",
      "diffPath": "/codebase/scape/scape/pull/8105/changes",
      "diffPainted": "visible [class*=\"changesTabPanel\"] plus first visible descendant [class*=\"lineContainer\"]"
    }
  }
};
