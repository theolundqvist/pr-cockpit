package relay

import (
	"bytes"
	"context"
	"encoding/json"
	"html"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

const (
	testInstall      = "6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7"
	otherTestInstall = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
	thirdTestInstall = "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e"
)

func analyticsEventAt(at time.Time, kind, action string, fields ...string) map[string]any {
	event := map[string]any{"at": at.UnixMilli(), "kind": kind, "action": action}
	for index := 0; index+1 < len(fields); index += 2 {
		event[fields[index]] = fields[index+1]
	}
	return event
}

func postAnalytics(t *testing.T, server *Server, contentType string, payload any) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/events", bytes.NewReader(body))
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	return response
}

func sendAnalytics(t *testing.T, server *Server, payload map[string]any) {
	t.Helper()
	if response := postAnalytics(t, server, "application/json", payload); response.Code != http.StatusNoContent {
		t.Fatalf("/events status = %d: %s", response.Code, response.Body)
	}
}

func appBatch(install string, events ...any) map[string]any {
	return map[string]any{"install": install, "surface": "app", "events": events}
}

func queryStrings(t *testing.T, store *Store, query string, args ...any) []string {
	t.Helper()
	rows, err := store.db.Query(query, args...)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var values []string
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			t.Fatal(err)
		}
		values = append(values, value)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return values
}

func TestAnalyticsIngestAcceptsAppSiteAndScriptBatches(t *testing.T) {
	server, store, clock := newAnchorRelay(t)
	now := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	clock.set(now)
	batches := []struct {
		contentType string
		payload     map[string]any
	}{
		{"application/json", map[string]any{
			"install": testInstall, "ref": "run-0001", "surface": "app", "version": "2f7e86b", "platform": "darwin", "future": true,
			"events": []any{
				analyticsEventAt(now, "screen", "detail/conversation", "client", "electron", "session", "tab-1"),
				analyticsEventAt(now, "step", "first-launch", "value", "new"),
				map[string]any{"at": now.UnixMilli(), "kind": "key", "action": "shift+m", "screen": "inbox", "value": nil, "extra": 1},
			},
		}},
		{"text/plain;charset=UTF-8", map[string]any{
			"anon": "tab-0001", "surface": "site", "platform": "windows",
			"events": []any{analyticsEventAt(now, "step", "visit", "value", "news.ycombinator.com", "screen", "home"), analyticsEventAt(now, "ui", "out:github.com")},
		}},
		{"", map[string]any{
			"anon": "run-0001", "surface": "script", "platform": "linux", "version": "v1.2.3",
			"events": []any{analyticsEventAt(now, "step", "script-start"), analyticsEventAt(now, "cli", "listen", "value", "ok", "client", "cli")},
		}},
	}
	for _, batch := range batches {
		if response := postAnalytics(t, server, batch.contentType, batch.payload); response.Code != http.StatusNoContent {
			t.Fatalf("%s batch status = %d: %s", batch.payload["surface"], response.Code, response.Body)
		}
	}
	subjects := queryStrings(t, store, `SELECT subject || '|' || surface || '|' || COALESCE(platform, '') || '|' || COALESCE(version, '') || '|' || COALESCE(ref, '') || '|' || first_ms FROM analytics_subjects ORDER BY subject`)
	want := []string{
		"a:run-0001|script|linux|v1.2.3||" + formatMS(now),
		"a:tab-0001|site|windows|||" + formatMS(now),
		"i:" + testInstall + "|app|darwin|2f7e86b|run-0001|" + formatMS(now),
	}
	if strings.Join(subjects, "\n") != strings.Join(want, "\n") {
		t.Fatalf("subjects = %q, want %q", subjects, want)
	}
	days := queryStrings(t, store, `SELECT subject || '|' || day || '|' || events FROM analytics_days ORDER BY subject`)
	if strings.Join(days, ",") != "a:run-0001|2026-11-05|2,a:tab-0001|2026-11-05|2,i:"+testInstall+"|2026-11-05|3" {
		t.Fatalf("days = %q", days)
	}
	counts := queryStrings(t, store, `SELECT kind || '|' || screen || '|' || action || '|' || value || '|' || client || '|' || n FROM analytics_counts WHERE subject = ? ORDER BY kind`, "i:"+testInstall)
	if strings.Join(counts, ",") != "key|inbox|shift+m|||1,screen||detail/conversation||electron|1,step||first-launch|new||1" {
		t.Fatalf("counts = %q", counts)
	}
	steps := queryStrings(t, store, `SELECT subject || '|' || step || '|' || value FROM analytics_steps ORDER BY subject, step`)
	if strings.Join(steps, ",") != "a:run-0001|script-start|,a:tab-0001|visit|news.ycombinator.com,i:"+testInstall+"|first-launch|new" {
		t.Fatalf("steps = %q", steps)
	}
}

func formatMS(at time.Time) string {
	return strconv.FormatInt(at.UnixMilli(), 10)
}

func TestAnalyticsIngestRejectsInvalidBatches(t *testing.T) {
	server, store, clock := newAnchorRelay(t)
	now := clock.now()
	tooMany := make([]any, maxAnalyticsEvents+1)
	for index := range tooMany {
		tooMany[index] = analyticsEventAt(now, "ui", "button")
	}
	for name, mutate := range map[string]func(map[string]any){
		"action with spaces": func(batch map[string]any) { batch["events"] = []any{analyticsEventAt(now, "ui", "merge pr")} },
		"uppercase action":   func(batch map[string]any) { batch["events"] = []any{analyticsEventAt(now, "ui", "Merge")} },
		"uppercase value": func(batch map[string]any) {
			batch["events"] = []any{analyticsEventAt(now, "ui", "merge", "value", "On")}
		},
		"screen with text": func(batch map[string]any) {
			batch["events"] = []any{analyticsEventAt(now, "ui", "merge", "screen", "Fix the bug")}
		},
		"empty action": func(batch map[string]any) { batch["events"] = []any{analyticsEventAt(now, "ui", "")} },
		"long action": func(batch map[string]any) {
			batch["events"] = []any{analyticsEventAt(now, "ui", strings.Repeat("a", 65))}
		},
		"unknown kind": func(batch map[string]any) { batch["events"] = []any{analyticsEventAt(now, "click", "merge")} },
		"unknown client": func(batch map[string]any) {
			batch["events"] = []any{analyticsEventAt(now, "ui", "merge", "client", "ui")}
		},
		"invalid session": func(batch map[string]any) {
			batch["events"] = []any{analyticsEventAt(now, "ui", "merge", "session", "tab/1")}
		},
		"non-numeric at": func(batch map[string]any) {
			batch["events"] = []any{map[string]any{"at": "now", "kind": "ui", "action": "merge"}}
		},
		"missing install":     func(batch map[string]any) { delete(batch, "install") },
		"invalid install":     func(batch map[string]any) { batch["install"] = "my laptop" },
		"site without anon":   func(batch map[string]any) { batch["surface"] = "site" },
		"script without anon": func(batch map[string]any) { batch["surface"] = "script" },
		"invalid anon":        func(batch map[string]any) { batch["surface"], batch["anon"] = "site", "tab_1" },
		"invalid ref":         func(batch map[string]any) { batch["ref"] = "run 1" },
		"bad surface":         func(batch map[string]any) { batch["surface"] = "desktop" },
		"missing surface":     func(batch map[string]any) { delete(batch, "surface") },
		"bad platform":        func(batch map[string]any) { batch["platform"] = "Darwin" },
		"bad version":         func(batch map[string]any) { batch["version"] = "1.0 beta" },
		"no events":           func(batch map[string]any) { batch["events"] = []any{} },
		"missing events":      func(batch map[string]any) { delete(batch, "events") },
		"too many events":     func(batch map[string]any) { batch["events"] = tooMany },
	} {
		batch := appBatch(testInstall, analyticsEventAt(now, "ui", "merge"))
		mutate(batch)
		if response := postAnalytics(t, server, "text/plain", batch); response.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", name, response.Code)
		}
	}
	for name, body := range map[string]string{
		"invalid JSON":   `{"surface":"app"`,
		"trailing JSON":  `{"surface":"app","install":"a","events":[{"kind":"ui","action":"x"}]} {}`,
		"oversized body": `{"surface":"app","install":"a","pad":"` + strings.Repeat("x", maxAnalyticsBody) + `","events":[{"kind":"ui","action":"x"}]}`,
	} {
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/events", strings.NewReader(body)))
		if response.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", name, response.Code)
		}
	}
	if subjects := queryStrings(t, store, `SELECT subject FROM analytics_subjects`); len(subjects) != 0 {
		t.Fatalf("rejected batches stored subjects %q", subjects)
	}
}

func TestAnalyticsCapsDropSilently(t *testing.T) {
	server, store, clock := newAnchorRelay(t)
	now := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	clock.set(now)
	sendAnalytics(t, server, appBatch(testInstall, analyticsEventAt(now, "ui", "first")))
	if _, err := store.db.Exec(`UPDATE analytics_days SET events = ? WHERE subject = ?`, maxAnalyticsSubjectDayEvents-1, "i:"+testInstall); err != nil {
		t.Fatal(err)
	}
	sendAnalytics(t, server, appBatch(testInstall,
		analyticsEventAt(now, "ui", "kept"), analyticsEventAt(now, "ui", "dropped"), analyticsEventAt(now, "step", "signed-in"),
		analyticsEventAt(now.AddDate(0, 0, -1), "ui", "yesterday"),
	))
	if days := queryStrings(t, store, `SELECT day || '|' || events FROM analytics_days ORDER BY day`); strings.Join(days, ",") != "2026-11-04|1,2026-11-05|5000" {
		t.Fatalf("days = %q", days)
	}
	if actions := queryStrings(t, store, `SELECT action FROM analytics_counts ORDER BY action`); strings.Join(actions, ",") != "first,kept,yesterday" {
		t.Fatalf("counted actions = %q", actions)
	}
	if steps := queryStrings(t, store, `SELECT step FROM analytics_steps`); len(steps) != 0 {
		t.Fatalf("capped step stored: %q", steps)
	}

	tx, err := store.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	for index := range maxAnalyticsNewSubjects {
		if _, err := tx.Exec(`INSERT INTO analytics_subjects(subject, surface, first_ms, last_ms) VALUES(?, 'site', ?, ?)`, "a:seed-"+formatCount(int64(index)), now.UnixMilli(), now.UnixMilli()); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	siteBatch := func(anon string) map[string]any {
		return map[string]any{"anon": anon, "surface": "site", "events": []any{analyticsEventAt(now, "step", "visit")}}
	}
	sendAnalytics(t, server, siteBatch("over-the-cap"))
	sendAnalytics(t, server, siteBatch("seed-0"))
	sendAnalytics(t, server, map[string]any{"anon": "script-run", "surface": "script", "events": []any{analyticsEventAt(now, "step", "script-start")}})
	if stored := queryStrings(t, store, `SELECT subject FROM analytics_subjects WHERE subject IN ('a:over-the-cap', 'a:script-run') ORDER BY subject`); strings.Join(stored, ",") != "a:script-run" {
		t.Fatalf("subjects past the cap = %q, want only the script run", stored)
	}
	if steps := queryStrings(t, store, `SELECT subject FROM analytics_steps WHERE step = 'visit'`); strings.Join(steps, ",") != "a:seed-0" {
		t.Fatalf("visit steps = %q, want the existing subject's", steps)
	}
	clock.set(now.AddDate(0, 0, 1))
	sendAnalytics(t, server, siteBatch("next-day"))
	if stored := queryStrings(t, store, `SELECT subject FROM analytics_subjects WHERE subject = 'a:next-day'`); len(stored) != 1 {
		t.Fatalf("next day's new subject was dropped")
	}
}

func TestAnalyticsStepsKeepFirstOccurrenceAndClampTime(t *testing.T) {
	server, store, clock := newAnchorRelay(t)
	now := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	clock.set(now)
	step := func() string {
		values := queryStrings(t, store, `SELECT first_ms || '|' || value FROM analytics_steps WHERE step = 'first-launch'`)
		return strings.Join(values, ",")
	}
	sendAnalytics(t, server, appBatch(testInstall, analyticsEventAt(now.Add(-time.Hour), "step", "first-launch", "value", "new")))
	sendAnalytics(t, server, appBatch(testInstall, analyticsEventAt(now, "step", "first-launch", "value", "existing")))
	if got, want := step(), formatMS(now.Add(-time.Hour))+"|new"; got != want {
		t.Fatalf("after a later occurrence step = %s, want %s", got, want)
	}
	sendAnalytics(t, server, appBatch(testInstall, analyticsEventAt(now.Add(-2*time.Hour), "step", "first-launch", "value", "existing")))
	if got, want := step(), formatMS(now.Add(-2*time.Hour))+"|existing"; got != want {
		t.Fatalf("after an earlier occurrence delivered late step = %s, want %s", got, want)
	}

	sendAnalytics(t, server, appBatch(otherTestInstall,
		analyticsEventAt(now.Add(-8*24*time.Hour), "step", "launch"),
		analyticsEventAt(now.Add(10*time.Minute), "step", "signed-in"),
		map[string]any{"kind": "step", "action": "repos-configured"},
	))
	times := queryStrings(t, store, `SELECT first_ms FROM analytics_steps WHERE subject = ? ORDER BY step`, "i:"+otherTestInstall)
	if len(times) != 3 || times[0] != formatMS(now) || times[1] != formatMS(now) || times[2] != formatMS(now) {
		t.Fatalf("out-of-window step times = %q, want the receive time", times)
	}
}

func TestAnalyticsCountsUpsert(t *testing.T) {
	server, store, clock := newAnchorRelay(t)
	now := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	clock.set(now)
	sendAnalytics(t, server, appBatch(testInstall,
		analyticsEventAt(now, "ui", "pr-header:merge", "screen", "detail/conversation"),
		analyticsEventAt(now, "ui", "pr-header:merge", "screen", "detail/conversation"),
		analyticsEventAt(now, "ui", "merge-approval", "value", "on", "client", "electron"),
	))
	sendAnalytics(t, server, appBatch(testInstall,
		analyticsEventAt(now, "ui", "pr-header:merge", "screen", "detail/conversation"),
		analyticsEventAt(now, "ui", "merge-approval", "value", "off", "client", "electron"),
	))
	counts := queryStrings(t, store, `SELECT screen || '|' || action || '|' || value || '|' || client || '|' || n FROM analytics_counts ORDER BY action, value`)
	if got := strings.Join(counts, ","); got != "|merge-approval|off|electron|1,|merge-approval|on|electron|1,detail/conversation|pr-header:merge|||3" {
		t.Fatalf("counts = %s", got)
	}
	if days := queryStrings(t, store, `SELECT events FROM analytics_days`); strings.Join(days, ",") != "5" {
		t.Fatalf("day events = %q", days)
	}
}

func TestProofSessionRecordsRelayConnectionAndAccountLink(t *testing.T) {
	server, store, clock := newAnchorRelay(t)
	after, tree := sha("a"), sha("b")
	pushAnchor(t, server, clock, "owner/repo", after, tree)
	proofs := map[string]string{"owner/repo": specProof("owner/repo", testRepoID, after, tree)}
	first := clock.now()
	open := func(body map[string]any) {
		t.Helper()
		body["proofs"] = proofs
		if session := openProofSession(t, server, body); session.status != http.StatusOK {
			t.Fatalf("session status = %d", session.status)
		}
	}
	open(map[string]any{"install": testInstall, "user": map[string]any{"id": 7, "login": "octo"}})
	clock.set(first.Add(time.Hour))
	open(map[string]any{"install": testInstall, "user": map[string]any{"id": 7, "login": "octo-renamed"}})
	open(map[string]any{"install": otherTestInstall, "user": map[string]any{"id": 0, "login": "anonymous"}})
	open(map[string]any{})

	subjects := queryStrings(t, store, `SELECT subject || '|' || surface || '|' || first_ms || '|' || last_ms FROM analytics_subjects ORDER BY subject`)
	want := []string{
		"i:" + otherTestInstall + "|app|" + formatMS(first.Add(time.Hour)) + "|" + formatMS(first.Add(time.Hour)),
		"i:" + testInstall + "|app|" + formatMS(first) + "|" + formatMS(first.Add(time.Hour)),
	}
	if strings.Join(subjects, ",") != strings.Join(want, ",") {
		t.Fatalf("subjects = %q, want %q", subjects, want)
	}
	steps := queryStrings(t, store, `SELECT subject || '|' || step || '|' || first_ms FROM analytics_steps ORDER BY subject`)
	if len(steps) != 2 || steps[1] != "i:"+testInstall+"|relay-connected|"+formatMS(first) {
		t.Fatalf("relay steps = %q", steps)
	}
	links := queryStrings(t, store, `SELECT install || '|' || github_user_id || '|' || login || '|' || first_ms || '|' || last_ms FROM analytics_links`)
	if strings.Join(links, ",") != testInstall+"|7|octo-renamed|"+formatMS(first)+"|"+formatMS(first.Add(time.Hour)) {
		t.Fatalf("links = %q", links)
	}
	if days := queryStrings(t, store, `SELECT day FROM analytics_days`); len(days) != 0 {
		t.Fatalf("a relay session counted as an active day: %q", days)
	}
}

func TestAnalyticsCleanupRetention(t *testing.T) {
	store := newUsageStore(t)
	now := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	day := func(age int) string { return now.AddDate(0, 0, -age).Format(time.DateOnly) }
	ms := func(age int) int64 { return now.AddDate(0, 0, -age).UnixMilli() }
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO analytics_counts VALUES(?, 'i:kept', 'ui', '', 'kept', '', '', 1)`, []any{day(180)}},
		{`INSERT INTO analytics_counts VALUES(?, 'i:kept', 'ui', '', 'expired', '', '', 1)`, []any{day(181)}},
		{`INSERT INTO analytics_days VALUES(?, 'i:kept', 1)`, []any{day(400)}},
		{`INSERT INTO analytics_days VALUES(?, 'i:kept', 1)`, []any{day(401)}},
		{`INSERT INTO analytics_subjects(subject, surface, first_ms, last_ms) VALUES('i:kept', 'app', ?, ?)`, []any{ms(500), ms(399)}},
		{`INSERT INTO analytics_subjects(subject, surface, first_ms, last_ms) VALUES('i:expired', 'app', ?, ?)`, []any{ms(500), ms(401)}},
		{`INSERT INTO analytics_subjects(subject, surface, first_ms, last_ms) VALUES('a:expired', 'site', ?, ?)`, []any{ms(500), ms(401)}},
		{`INSERT INTO analytics_steps VALUES('i:kept', 'first-launch', ?, 'new')`, []any{ms(500)}},
		{`INSERT INTO analytics_steps VALUES('i:expired', 'first-launch', ?, 'new')`, []any{ms(500)}},
		{`INSERT INTO analytics_steps VALUES('a:expired', 'visit', ?, '')`, []any{ms(500)}},
		{`INSERT INTO analytics_links VALUES('kept', 1, 'kept-login', ?, ?)`, []any{ms(500), ms(399)}},
		{`INSERT INTO analytics_links VALUES('expired', 2, 'expired-login', ?, ?)`, []any{ms(500), ms(401)}},
	} {
		if _, err := store.db.Exec(statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.cleanup(context.Background(), now); err != nil {
		t.Fatal(err)
	}
	for query, want := range map[string]string{
		`SELECT action FROM analytics_counts`:    "kept",
		`SELECT day FROM analytics_days`:         day(400),
		`SELECT subject FROM analytics_subjects`: "i:kept",
		`SELECT subject FROM analytics_steps`:    "i:kept",
		`SELECT install FROM analytics_links`:    "kept",
	} {
		if got := strings.Join(queryStrings(t, store, query), ","); got != want {
			t.Errorf("%s = %q, want %q", query, got, want)
		}
	}
}

func TestAnalyticsLabelsAreHumanNames(t *testing.T) {
	for _, label := range []struct{ kind, action, want string }{
		{"ui", "pr-header:merge", "Merge · PR header"},
		{"ui", "settings:usage-stats", "Usage stats · Settings"},
		{"ui", "out:github.com", "Link out · github.com"},
		{"ui", "to:install", "Link to Install"},
		{"step", "mutation:merge", "Merge PR"},
		{"step", "mutation:reply-to-thread", "Reply to thread"},
		{"step", "mutation:something-new", "Something new"},
		{"step", "saw-install", "Saw install command"},
		{"step", "github-app-setup", "GitHub App setup"},
		{"screen", "detail/conversation", "PR · Conversation"},
		{"screen", "settings/usage", "Settings · Usage"},
		{"screen", "onboarding/choose", "Onboarding · Choose"},
		{"screen", "app-setup", "App setup"},
		{"key", "shift+m", "Force merge"},
		{"key", "slash", "Search / filter"},
		{"key", "cmd+comma", "Settings"},
		{"key", "cmd+shift+y", "⌘⇧Y"},
		{"cli", "listen", "pr-cockpit listen"},
	} {
		if got := analyticsLabel(label.kind, label.action); got != label.want {
			t.Errorf("label(%s, %s) = %q, want %q", label.kind, label.action, got, label.want)
		}
	}
}

func TestAnalyticsPanelRendersFunnelAndHumanLabels(t *testing.T) {
	server, store, clock := newAnchorRelay(t)
	ctx := context.Background()
	now := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	at := func(age time.Duration) time.Time {
		clock.set(now.Add(-age))
		return clock.now()
	}
	const day = 24 * time.Hour

	sendAnalytics(t, server, map[string]any{"anon": "tab-a-0001", "surface": "site", "platform": "windows", "events": []any{
		analyticsEventAt(at(12*day), "step", "visit", "value", "news.ycombinator.com", "screen", "home"),
		analyticsEventAt(at(12*day), "screen", "home"),
		analyticsEventAt(at(12*day), "step", "saw-install", "screen", "home"),
		analyticsEventAt(at(12*day), "ui", "to:install", "screen", "home"),
		analyticsEventAt(at(12*day), "step", "copy-install", "value", "manual", "screen", "home"),
	}})
	sendAnalytics(t, server, map[string]any{"anon": "tab-b-0002", "surface": "site", "events": []any{analyticsEventAt(at(12*day), "step", "visit", "value", "direct")}})
	sendAnalytics(t, server, map[string]any{"anon": "run-r-0001", "surface": "script", "platform": "darwin", "events": []any{
		analyticsEventAt(at(11*day), "step", "script-start"), analyticsEventAt(at(11*day), "step", "script-done"),
	}})

	launched := at(10 * day)
	sendAnalytics(t, server, map[string]any{"install": testInstall, "ref": "run-r-0001", "surface": "app", "platform": "darwin", "version": "2f7e86b", "events": []any{
		analyticsEventAt(launched, "step", "first-launch", "value", "new", "client", "server"),
		analyticsEventAt(launched, "step", "auth", "value", "missing-auth"),
		analyticsEventAt(launched, "step", "signed-in"),
		analyticsEventAt(launched, "step", "repos-configured"),
		analyticsEventAt(launched, "screen", "detail/conversation", "client", "electron"),
		analyticsEventAt(launched, "screen", "settings/usage", "client", "electron"),
		analyticsEventAt(launched, "ui", "pr-header:merge", "screen", "detail/conversation", "client", "electron"),
		analyticsEventAt(launched, "key", "shift+m", "screen", "detail/conversation", "client", "electron"),
		analyticsEventAt(launched, "step", "mutation:merge", "value", "ok"),
		analyticsEventAt(launched, "cli", "diff", "value", "ok", "client", "cli", "session", "a1b2c3d4e5f60718"),
	}})
	if err := store.RecordRelayConnection(ctx, testInstall, &GitHubIdentity{ID: 987654321, Login: "octo-fixture"}, launched); err != nil {
		t.Fatal(err)
	}
	sendAnalytics(t, server, appBatch(testInstall, analyticsEventAt(at(9*day), "screen", "inbox")))
	sendAnalytics(t, server, appBatch(testInstall, analyticsEventAt(at(2*day), "screen", "inbox")))

	sendAnalytics(t, server, map[string]any{"install": otherTestInstall, "surface": "app", "platform": "linux", "events": []any{
		analyticsEventAt(at(3*day), "step", "first-launch", "value", "new"),
		analyticsEventAt(at(3*day), "step", "auth", "value", "missing-cli"),
		analyticsEventAt(at(3*day).Add(time.Minute), "step", "auth", "value", "authorizing"),
	}})
	sendAnalytics(t, server, appBatch(thirdTestInstall, analyticsEventAt(at(day), "step", "first-launch", "value", "existing")))

	for _, activity := range []struct {
		id  int64
		age time.Duration
	}{{987654321, 10 * day}, {987654321, 2 * day}, {123456789, 0}} {
		if err := store.RecordActivity(ctx, GitHubIdentity{ID: activity.id, Login: "octo-fixture"}, []string{"owner/private-repo"}, now.Add(-activity.age)); err != nil {
			t.Fatal(err)
		}
	}
	clock.set(now)

	panel, err := store.AnalyticsPanel(ctx, 30, 12, now)
	if err != nil {
		t.Fatal(err)
	}
	var stages []string
	for _, group := range panel.Funnel {
		for _, row := range group.Rows {
			count := row.Count
			if row.Empty {
				count = "empty"
			}
			stages = append(stages, row.Label+"="+count+"/"+row.Percent)
		}
	}
	wantStages := []string{
		"Site visit=2/", "Saw install command=1/50%", "Copied install command=1/100%",
		"Install script started=1/100%", "Install script finished=1/100%",
		"First launch=2/200%", "GitHub signed in=1/50%", "Repos chosen=1/100%", "First relay connection=1/100%",
		"Active again on day 1+=1/100%", "Active again on day 7+=1/100%", "Active again on day 30+=empty/",
	}
	if strings.Join(stages, ", ") != strings.Join(wantStages, ", ") {
		t.Fatalf("funnel = %q\nwant %q", stages, wantStages)
	}
	if rows := panel.AuthDropoff.Rows; len(rows) != 1 || rows[0][0].Text != "Authorizing in the browser" || rows[0][1].Text != "1" {
		t.Fatalf("auth drop-off = %#v", rows)
	}

	response := httptest.NewRecorder()
	server.AdminHandler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/analytics", nil))
	if response.Code != http.StatusOK || !strings.HasPrefix(response.Header().Get("Content-Type"), "text/html") {
		t.Fatalf("/analytics status = %d, content type %q", response.Code, response.Header().Get("Content-Type"))
	}
	page := html.UnescapeString(response.Body.String())
	if path := os.Getenv("RELAY_ANALYTICS_PREVIEW"); path != "" {
		if err := os.WriteFile(path, response.Body.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, want := range []string{
		"Site visit", "Saw install command", "Copied install command", "Install script started", "Install script finished",
		"First launch", "GitHub signed in", "Repos chosen", "First relay connection", "Active again on day 30+",
		"no data yet", "aggregate ratio", "1 of these installs carry their script run", "Not observable here",
		"Merge PR", "Merge · PR header", "Force merge", "PR · Conversation", "Settings · Usage", "pr-cockpit diff",
		"Link to Install", "Authorizing in the browser", "macOS", "2f7e86b", "Retention by first week", "Toward 10,000 users",
	} {
		if !strings.Contains(strings.ToLower(page), strings.ToLower(want)) {
			t.Errorf("panel lacks %q", want)
		}
	}
	for _, secret := range []string{testInstall, otherTestInstall, thirdTestInstall, "tab-a-0001", "tab-b-0002", "run-r-0001", "a1b2c3d4e5f60718", "987654321", "123456789", "octo-fixture", "private-repo"} {
		if strings.Contains(page, secret) {
			t.Errorf("panel exposes %q", secret)
		}
	}
	if uuid := regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-`).FindString(page); uuid != "" {
		t.Errorf("panel exposes a UUID-like id %q", uuid)
	}

	public := httptest.NewRecorder()
	server.Handler().ServeHTTP(public, httptest.NewRequest(http.MethodGet, "/analytics", nil))
	if public.Code != http.StatusNotFound {
		t.Fatalf("public /analytics status = %d, want 404", public.Code)
	}
	for _, path := range []string{"/analytics?days=0", "/analytics?days=181", "/analytics?days=x", "/analytics?weeks=0", "/analytics?weeks=53"} {
		response := httptest.NewRecorder()
		server.AdminHandler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusBadRequest {
			t.Errorf("%s status = %d, want 400", path, response.Code)
		}
	}
}

func TestAnalyticsPanelRendersEmptyStore(t *testing.T) {
	server, _, _ := newAnchorRelay(t)
	response := httptest.NewRecorder()
	server.AdminHandler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/analytics?days=180&weeks=52", nil))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "no data yet") {
		t.Fatalf("empty panel status = %d", response.Code)
	}
}
