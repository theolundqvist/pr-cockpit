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

Cursor Origin: Origin PR #8105 list row to first painted PR detail

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

PR Cockpit: ⌘K palette open, query applied, to painted scape#8133 result

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

Cursor Origin: Origin PR #8105 Changes tab to first painted diff line

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

Pull-request list row for #8132 to painted detail: title, first conversation body, no loading indicator

| Product | Runs | min | p50 | p90 | p95 | p99 | max | mean |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PR Cockpit | 100 | 61.2 | 93.1 | 135.1 | 150.6 | 395.2 | 873.3 | 109.8 |
| GitHub | 100 | 2591.5 | 3380.7 | 4484.7 | 4879.6 | 5678.4 | 6495.1 | 3520.8 |
| Cursor Origin | 100 | 1178.8 | 1738.0 | 3198.7 | 3702.4 | 5606.3 | 5809.6 | 2084.9 |

### Every run in milliseconds

PR Cockpit: Inbox row to painted detail of #8132

GitHub: Pull-request list row to painted detail of #8132

Cursor Origin: Origin pull-request row to painted detail of #8132

| Run | PR Cockpit | GitHub | Cursor Origin |
| --- | --- | --- | --- |
| 1 | 89.1 | 3512.5 | 1253.6 |
| 2 | 87.0 | 2821.5 | 3052.5 |
| 3 | 100.3 | 2855.2 | 4968.1 |
| 4 | 79.0 | 3205.9 | 3514.2 |
| 5 | 77.3 | 3073.4 | 1687.7 |
| 6 | 117.8 | 3310.3 | 1479.3 |
| 7 | 112.5 | 3293.7 | 1858.7 |
| 8 | 70.3 | 2842.3 | 1991.6 |
| 9 | 71.4 | 2861.0 | 1419.6 |
| 10 | 150.6 | 2591.5 | 1927.9 |
| 11 | 73.2 | 3200.5 | 1580.7 |
| 12 | 89.3 | 2618.3 | 1687.2 |
| 13 | 94.8 | 3872.5 | 2046.1 |
| 14 | 120.9 | 2988.8 | 1642.5 |
| 15 | 110.3 | 2756.6 | 2601.9 |
| 16 | 89.8 | 2964.1 | 2582.4 |
| 17 | 81.2 | 3627.4 | 1457.6 |
| 18 | 91.0 | 2902.9 | 1826.6 |
| 19 | 73.8 | 4015.5 | 1751.6 |
| 20 | 65.7 | 3827.5 | 1504.7 |
| 21 | 83.7 | 3086.9 | 1859.6 |
| 22 | 100.9 | 2702.7 | 1580.9 |
| 23 | 395.2 | 2718.4 | 1633.5 |
| 24 | 108.7 | 4657.2 | 1389.8 |
| 25 | 75.5 | 3274.3 | 1424.8 |
| 26 | 100.2 | 2873.9 | 1691.2 |
| 27 | 100.8 | 3759.5 | 1927.7 |
| 28 | 96.0 | 2619.6 | 1821.8 |
| 29 | 93.1 | 2832.0 | 1507.5 |
| 30 | 87.4 | 3118.7 | 1565.6 |
| 31 | 80.8 | 5024.4 | 1587.4 |
| 32 | 78.6 | 3387.0 | 1304.8 |
| 33 | 116.5 | 6495.1 | 2021.3 |
| 34 | 129.4 | 3756.2 | 3920.5 |
| 35 | 76.6 | 3605.2 | 2308.5 |
| 36 | 144.9 | 3385.6 | 3073.4 |
| 37 | 119.2 | 3352.6 | 1974.2 |
| 38 | 146.7 | 3380.7 | 1849.5 |
| 39 | 90.2 | 2849.5 | 1919.6 |
| 40 | 75.6 | 3864.9 | 1772.9 |
| 41 | 120.2 | 3644.7 | 2107.1 |
| 42 | 160.1 | 3244.6 | 1827.0 |
| 43 | 135.1 | 3076.6 | 1621.4 |
| 44 | 83.4 | 3688.8 | 1762.1 |
| 45 | 106.8 | 2785.0 | 1450.4 |
| 46 | 86.8 | 2760.8 | 1720.8 |
| 47 | 81.6 | 4848.8 | 3702.4 |
| 48 | 91.7 | 4231.5 | 3249.4 |
| 49 | 67.6 | 3154.4 | 1178.8 |
| 50 | 114.2 | 3696.6 | 1554.6 |
| 51 | 115.9 | 3088.9 | 3146.9 |
| 52 | 67.0 | 3389.0 | 3150.8 |
| 53 | 73.6 | 4404.9 | 1581.4 |
| 54 | 78.4 | 3293.1 | 1900.9 |
| 55 | 100.2 | 3856.1 | 1633.5 |
| 56 | 73.6 | 4484.7 | 1980.8 |
| 57 | 115.8 | 3716.6 | 1758.7 |
| 58 | 88.5 | 4060.6 | 1601.4 |
| 59 | 72.7 | 5110.4 | 3012.8 |
| 60 | 77.6 | 3107.7 | 2858.6 |
| 61 | 61.2 | 2780.4 | 3214.6 |
| 62 | 84.3 | 4519.4 | 5606.3 |
| 63 | 91.0 | 3548.5 | 1621.3 |
| 64 | 85.7 | 3283.7 | 1432.4 |
| 65 | 165.1 | 5678.4 | 1381.1 |
| 66 | 133.3 | 3584.4 | 1428.0 |
| 67 | 87.7 | 2976.1 | 5809.6 |
| 68 | 67.6 | 4904.4 | 3051.7 |
| 69 | 119.0 | 3680.3 | 1304.3 |
| 70 | 87.7 | 3071.3 | 1271.0 |
| 71 | 65.5 | 3397.9 | 1381.2 |
| 72 | 95.4 | 3678.4 | 1447.1 |
| 73 | 93.8 | 4818.7 | 3455.8 |
| 74 | 88.2 | 3431.7 | 2530.7 |
| 75 | 120.6 | 3753.1 | 1675.7 |
| 76 | 147.9 | 3046.9 | 1989.3 |
| 77 | 121.3 | 4224.6 | 1940.9 |
| 78 | 88.8 | 3599.5 | 2741.8 |
| 79 | 77.4 | 3930.3 | 2097.0 |
| 80 | 123.9 | 4344.1 | 1416.6 |
| 81 | 204.7 | 3408.3 | 1731.2 |
| 82 | 114.4 | 2769.8 | 1380.0 |
| 83 | 112.7 | 4879.6 | 1727.8 |
| 84 | 97.1 | 3963.1 | 1655.2 |
| 85 | 873.3 | 3184.9 | 5212.8 |
| 86 | 77.5 | 3863.4 | 1679.8 |
| 87 | 114.8 | 2964.9 | 1811.7 |
| 88 | 102.9 | 2933.9 | 1738.0 |
| 89 | 91.7 | 3434.9 | 1524.9 |
| 90 | 110.8 | 3001.2 | 1614.2 |
| 91 | 116.8 | 3255.3 | 3198.7 |
| 92 | 71.4 | 3542.7 | 1644.9 |
| 93 | 117.4 | 3190.0 | 2326.0 |
| 94 | 109.0 | 2941.1 | 1467.9 |
| 95 | 108.0 | 3424.6 | 1856.6 |
| 96 | 94.8 | 2946.6 | 1591.5 |
| 97 | 65.5 | 4174.4 | 1665.4 |
| 98 | 142.0 | 2931.4 | 1730.3 |
| 99 | 102.9 | 3188.1 | 1511.0 |
| 100 | 91.7 | 4303.2 | 1858.2 |

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
| dataset | PR Cockpit global cache and GitHub's scape-app/scape pull-request list receive the query "remove harness efficiency"; Cockpit requires scape-app/scape#8133 |
| cache | Warm browser cache and warm PR Cockpit disk cache; neither is cleared between warmups or measured runs |
| cockpitURL | http://127.0.0.1:4825 |
| resultsURL | https://github.com/scape-app/scape/pulls?q=is%3Apr%20is%3Aopen%20remove%20%20harness%20efficiency |
| cdp | http://127.0.0.1:9334 |
| paintBoundary | PR Cockpit: palette shortcut and programmatic query application to painted scape-app/scape#8133; GitHub: repo-scoped query URL navigation to first painted result; both followed by two requestAnimationFrame callbacks |

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
| dataset | scape-app/scape staging; representative open PR #8105 |
| cache | Warm authenticated browser profile and HTTP cache; cache is not cleared between warmups or measured runs |
| sourceURL | https://cursor.com/codebase/scape/scape/tree/staging |
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
| dataset | scape-app/scape#8132, a large open pull request |
| cache | Warm browser cache and warm PR Cockpit disk cache; neither is cleared between warmups or measured runs |
| cockpitURL | http://127.0.0.1:4825/#/pr/scape-app/scape/8132 |
| githubListURL | https://github.com/scape-app/scape/pulls?q=is%3Apr%208132 |
| cursorListURL | https://cursor.com/codebase/scape/scape/pulls?q=is%3Apr+is%3Aopen+author%3A%40me |
| cdp | http://127.0.0.1:9334 |
| paintBoundary | Pull-request list row for #8132 to painted detail: title, first conversation body, no loading indicator, followed by two requestAnimationFrame callbacks |
| percentiles | p99 is the 99th of 100 measured samples per product, not an interpolated estimate |
| transientRetries | Iterations lost to a transient network error are retried and never recorded as samples |

