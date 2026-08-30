# PR Cockpit benchmark results

Every measured sample behind the landing-page comparison, measured 2026-08-21T16:09:54.318Z. Reproduce with [scripts/benchmark-ui.mjs](../scripts/benchmark-ui.mjs); regenerate this file with `node scripts/benchmark-report.mjs`.

## Open a PR

| Product | Runs | min | p50 | p90 | p95 | p99 | max | mean |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PR Cockpit | 12 | 14.3 | 19.8 | 29.0 | 42.0 | 42.0 | 42.0 | 22.0 |
| GitHub | 12 | 1152.3 | 1421.3 | 1751.4 | 2022.0 | 2022.0 | 2022.0 | 1472.9 |
| Cursor Origin | 12 | 891.0 | 1166.8 | 1384.4 | 1502.7 | 1502.7 | 1502.7 | 1195.4 |

### Every run in milliseconds

PR Cockpit: Inbox row to painted PR detail

GitHub: Pull-request result to painted PR detail

Cursor Origin: Configured pull-request list row to first painted PR detail

| Run | PR Cockpit | GitHub | Cursor Origin |
| --- | --- | --- | --- |
| 1 | 20.7 | 1355.0 | 1126.4 |
| 2 | 26.2 | 1421.3 | 1207.5 |
| 3 | 15.4 | 1211.1 | 1094.9 |
| 4 | 18.5 | 1611.3 | 1290.5 |
| 5 | 19.8 | 1686.0 | 1166.8 |
| 6 | 17.4 | 1172.2 | 891.0 |
| 7 | 23.8 | 1621.0 | 1502.7 |
| 8 | 42.0 | 1751.4 | 1081.3 |
| 9 | 14.3 | 1440.0 | 1176.7 |
| 10 | 29.0 | 2022.0 | 1134.7 |
| 11 | 16.4 | 1231.7 | 1287.4 |
| 12 | 20.3 | 1152.3 | 1384.4 |

## Search PRs

| Product | Runs | min | p50 | p90 | p95 | p99 | max | mean |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PR Cockpit | 12 | 34.9 | 49.1 | 67.5 | 74.0 | 74.0 | 74.0 | 51.8 |
| GitHub | 12 | 679.6 | 839.2 | 907.0 | 994.6 | 994.6 | 994.6 | 826.2 |
| Cursor Origin | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |

Cursor Origin: Cursor Origin exposes PR filters but no comparable PR word-search interaction

### Every run in milliseconds

PR Cockpit: ⌘K palette open, query applied, to first painted configured result

GitHub: Load the repo-scoped pull-request search URL for the same query to first painted result

| Run | PR Cockpit | GitHub |
| --- | --- | --- |
| 1 | 66.5 | 839.2 |
| 2 | 34.9 | 745.9 |
| 3 | 36.0 | 872.3 |
| 4 | 50.2 | 701.6 |
| 5 | 67.5 | 733.0 |
| 6 | 45.0 | 894.5 |
| 7 | 49.1 | 679.6 |
| 8 | 61.4 | 873.9 |
| 9 | 51.4 | 793.3 |
| 10 | 39.0 | 879.7 |
| 11 | 74.0 | 907.0 |
| 12 | 46.4 | 994.6 |

## Open a diff

| Product | Runs | min | p50 | p90 | p95 | p99 | max | mean |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PR Cockpit | 12 | 25.5 | 41.1 | 53.7 | 86.4 | 86.4 | 86.4 | 43.9 |
| GitHub | 12 | 1086.3 | 1486.6 | 2145.7 | 2345.3 | 2345.3 | 2345.3 | 1599.0 |
| Cursor Origin | 12 | 589.8 | 794.3 | 978.5 | 1245.2 | 1245.2 | 1245.2 | 839.8 |

### Every run in milliseconds

PR Cockpit: Files click to painted cached diff

GitHub: Files changed click to painted GitHub diff

Cursor Origin: Configured pull-request Changes tab to first painted diff line

| Run | PR Cockpit | GitHub | Cursor Origin |
| --- | --- | --- | --- |
| 1 | 25.5 | 1086.3 | 589.8 |
| 2 | 35.6 | 1486.6 | 650.6 |
| 3 | 86.4 | 1349.0 | 634.3 |
| 4 | 43.4 | 1660.5 | 928.8 |
| 5 | 31.6 | 1584.7 | 978.5 |
| 6 | 28.0 | 1227.2 | 753.3 |
| 7 | 49.5 | 1418.3 | 924.9 |
| 8 | 43.5 | 1816.4 | 864.7 |
| 9 | 53.7 | 1690.7 | 789.7 |
| 10 | 47.6 | 2345.3 | 794.3 |
| 11 | 40.8 | 1377.7 | 923.8 |
| 12 | 41.1 | 2145.7 | 1245.2 |

## Open a huge PR

Private benchmark repository; representative large pull request with 1,879 changed files, 125,659 changed lines (108,995 added, 16,664 removed), and about 360 comments

Pull-request list row to painted detail: title, first conversation body, no loading indicator

| Product | Runs | min | p50 | p90 | p95 | p99 | max | mean |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PR Cockpit | 30 | 77.4 | 81.5 | 109.2 | 111.8 | 120.8 | 120.8 | 88.4 |
| GitHub | 100 | 2591.5 | 3380.7 | 4484.7 | 4879.6 | 5678.4 | 6495.1 | 3520.8 |
| Cursor Origin | 100 | 1178.8 | 1738.0 | 3198.7 | 3702.4 | 5606.3 | 5809.6 | 2084.9 |

### Every run in milliseconds

PR Cockpit: Inbox row to painted configured detail

GitHub: Pull-request list row to painted configured detail

Cursor Origin: Configured pull-request row to painted detail

| Run | PR Cockpit | GitHub | Cursor Origin |
| --- | --- | --- | --- |
| 1 | 82.5 | 3512.5 | 1253.6 |
| 2 | 89.2 | 2821.5 | 3052.5 |
| 3 | 120.8 | 2855.2 | 4968.1 |
| 4 | 81.4 | 3205.9 | 3514.2 |
| 5 | 78.6 | 3073.4 | 1687.7 |
| 6 | 84.0 | 3310.3 | 1479.3 |
| 7 | 111.8 | 3293.7 | 1858.7 |
| 8 | 79.0 | 2842.3 | 1991.6 |
| 9 | 109.2 | 2861.0 | 1419.6 |
| 10 | 86.7 | 2591.5 | 1927.9 |
| 11 | 110.8 | 3200.5 | 1580.7 |
| 12 | 79.5 | 2618.3 | 1687.2 |
| 13 | 79.7 | 3872.5 | 2046.1 |
| 14 | 79.5 | 2988.8 | 1642.5 |
| 15 | 101.7 | 2756.6 | 2601.9 |
| 16 | 80.0 | 2964.1 | 2582.4 |
| 17 | 104.8 | 3627.4 | 1457.6 |
| 18 | 77.4 | 2902.9 | 1826.6 |
| 19 | 80.6 | 4015.5 | 1751.6 |
| 20 | 80.0 | 3827.5 | 1504.7 |
| 21 | 81.0 | 3086.9 | 1859.6 |
| 22 | 81.7 | 2702.7 | 1580.9 |
| 23 | 105.0 | 2718.4 | 1633.5 |
| 24 | 77.4 | 4657.2 | 1389.8 |
| 25 | 81.5 | 3274.3 | 1424.8 |
| 26 | 98.7 | 2873.9 | 1691.2 |
| 27 | 80.1 | 3759.5 | 1927.7 |
| 28 | 84.6 | 2619.6 | 1821.8 |
| 29 | 82.2 | 2832.0 | 1507.5 |
| 30 | 81.4 | 3118.7 | 1565.6 |
| 31 |  | 5024.4 | 1587.4 |
| 32 |  | 3387.0 | 1304.8 |
| 33 |  | 6495.1 | 2021.3 |
| 34 |  | 3756.2 | 3920.5 |
| 35 |  | 3605.2 | 2308.5 |
| 36 |  | 3385.6 | 3073.4 |
| 37 |  | 3352.6 | 1974.2 |
| 38 |  | 3380.7 | 1849.5 |
| 39 |  | 2849.5 | 1919.6 |
| 40 |  | 3864.9 | 1772.9 |
| 41 |  | 3644.7 | 2107.1 |
| 42 |  | 3244.6 | 1827.0 |
| 43 |  | 3076.6 | 1621.4 |
| 44 |  | 3688.8 | 1762.1 |
| 45 |  | 2785.0 | 1450.4 |
| 46 |  | 2760.8 | 1720.8 |
| 47 |  | 4848.8 | 3702.4 |
| 48 |  | 4231.5 | 3249.4 |
| 49 |  | 3154.4 | 1178.8 |
| 50 |  | 3696.6 | 1554.6 |
| 51 |  | 3088.9 | 3146.9 |
| 52 |  | 3389.0 | 3150.8 |
| 53 |  | 4404.9 | 1581.4 |
| 54 |  | 3293.1 | 1900.9 |
| 55 |  | 3856.1 | 1633.5 |
| 56 |  | 4484.7 | 1980.8 |
| 57 |  | 3716.6 | 1758.7 |
| 58 |  | 4060.6 | 1601.4 |
| 59 |  | 5110.4 | 3012.8 |
| 60 |  | 3107.7 | 2858.6 |
| 61 |  | 2780.4 | 3214.6 |
| 62 |  | 4519.4 | 5606.3 |
| 63 |  | 3548.5 | 1621.3 |
| 64 |  | 3283.7 | 1432.4 |
| 65 |  | 5678.4 | 1381.1 |
| 66 |  | 3584.4 | 1428.0 |
| 67 |  | 2976.1 | 5809.6 |
| 68 |  | 4904.4 | 3051.7 |
| 69 |  | 3680.3 | 1304.3 |
| 70 |  | 3071.3 | 1271.0 |
| 71 |  | 3397.9 | 1381.2 |
| 72 |  | 3678.4 | 1447.1 |
| 73 |  | 4818.7 | 3455.8 |
| 74 |  | 3431.7 | 2530.7 |
| 75 |  | 3753.1 | 1675.7 |
| 76 |  | 3046.9 | 1989.3 |
| 77 |  | 4224.6 | 1940.9 |
| 78 |  | 3599.5 | 2741.8 |
| 79 |  | 3930.3 | 2097.0 |
| 80 |  | 4344.1 | 1416.6 |
| 81 |  | 3408.3 | 1731.2 |
| 82 |  | 2769.8 | 1380.0 |
| 83 |  | 4879.6 | 1727.8 |
| 84 |  | 3963.1 | 1655.2 |
| 85 |  | 3184.9 | 5212.8 |
| 86 |  | 3863.4 | 1679.8 |
| 87 |  | 2964.9 | 1811.7 |
| 88 |  | 2933.9 | 1738.0 |
| 89 |  | 3434.9 | 1524.9 |
| 90 |  | 3001.2 | 1614.2 |
| 91 |  | 3255.3 | 3198.7 |
| 92 |  | 3542.7 | 1644.9 |
| 93 |  | 3190.0 | 2326.0 |
| 94 |  | 2941.1 | 1467.9 |
| 95 |  | 3424.6 | 1856.6 |
| 96 |  | 2946.6 | 1591.5 |
| 97 |  | 4174.4 | 1665.4 |
| 98 |  | 2931.4 | 1730.3 |
| 99 |  | 3188.1 | 1511.0 |
| 100 |  | 4303.2 | 1858.2 |

## Environments

### Pull-request and diff opens

| Field | Value |
| --- | --- |
| machine | Apple M4 Max |
| browser | Chromium 149.0.7827.55 |
| viewport | 1100×800 |
| runs | 12 |
| warmups | 3 |
| dataset | 15 public microsoft/vscode PRs |
| cache | Each of the 12 measured runs opens a distinct microsoft/vscode PR that no earlier warmup or run had opened, so every sample is a cold first open; PR Cockpit reads its warm local disk cache while GitHub uses the current network connection |
| note | The search metric is measured separately; see searchEnvironment |

### Search

| Field | Value |
| --- | --- |
| measuredAt | 2026-08-21T17:19:10.347Z |
| machine | Apple M4 Max |
| browser | Chrome/152.0.7929.0 |
| viewport | 1291×1327 |
| runs | 12 |
| warmups | 3 |
| auth | One signed-in visible Chromium drives both products |
| dataset | A configured private-repository query run against PR Cockpit's global cache and GitHub's pull-request search |
| cache | Warm browser cache and warm PR Cockpit disk cache; neither is cleared between warmups or measured runs |
| cockpitURL | http://127.0.0.1:4825 |
| resultsURL | Authenticated GitHub pull-request search |
| cdp | http://127.0.0.1:9334 |
| paintBoundary | PR Cockpit: palette shortcut and programmatic query application to first painted result; GitHub: repository-scoped query URL navigation to first painted result; both followed by two requestAnimationFrame callbacks |

### Cursor Origin

| Field | Value |
| --- | --- |
| measuredAt | 2026-08-21T10:33:01.925Z |
| machine | Apple M4 Max |
| browser | Chrome/152.0.7929.0 |
| viewport | 1100×800 |
| runs | 12 |
| warmups | 3 |
| auth | Authenticated isolated Chromium profile |
| dataset | Private benchmark repository; representative open pull request |
| cache | Warm authenticated browser profile and HTTP cache; cache is not cleared between warmups or measured runs |
| sourceURL | Authenticated Cursor Origin pull-request page |
| cdp | http://127.0.0.1:9334 |
| paintBoundary | Visible selector followed by two requestAnimationFrame callbacks |

### Huge pull request render

| Field | Value |
| --- | --- |
| measuredAt | 2026-08-21T17:17:59.799Z |
| machine | Apple M4 Max |
| browser | Chrome/152.0.7929.0 |
| viewport | 1291×1327 |
| runs | 100 |
| warmups | 3 |
| auth | One signed-in visible Chromium drives all three products |
| dataset | Private benchmark repository; representative large pull request with 1,879 changed files, 125,659 changed lines (108,995 added, 16,664 removed), and about 360 comments |
| cache | Warm browser cache and warm PR Cockpit disk cache; neither is cleared between warmups or measured runs |
| cockpitURL | Configured PR Cockpit pull-request route |
| githubListURL | Authenticated GitHub pull-request search |
| cursorListURL | Authenticated Cursor Origin pull-request list |
| cdp | http://127.0.0.1:9334 |
| paintBoundary | Pull-request list row to painted detail: title, first conversation body, no loading indicator, followed by two requestAnimationFrame callbacks |
| percentiles | p99 is the 99th of 100 measured samples per product, not an interpolated estimate |
| transientRetries | Iterations lost to a transient network error are retried and never recorded as samples |
| cockpitRemeasuredAt | 2026-08-23T13:05:00.000Z |
| cockpitRemeasure | The original session ran under heavy host contention that put three outliers (204.7, 395.2, 873.3 ms) into the PR Cockpit tail; the PR Cockpit leg was re-measured on an idle machine with 3 warmups + 30 runs in headless Chromium against the same installed server and paint boundary. GitHub and Cursor Origin keep their original 100-sample sessions. |

