package relay

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func newUsageStore(t *testing.T) *Store {
	t.Helper()
	store, err := OpenStore(filepath.Join(t.TempDir(), "relay.db"), 7*24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	return store
}

func TestActivityUpsertUsesUTCDayAndUpdatesLoginAndSessions(t *testing.T) {
	store := newUsageStore(t)
	zone := time.FixedZone("UTC+2", 2*60*60)
	first := time.Date(2026, 9, 1, 1, 30, 0, 0, zone)
	last := first.Add(20 * time.Minute)
	if err := store.RecordActivity(context.Background(), GitHubIdentity{ID: 42, Login: "old-login"}, first); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordActivity(context.Background(), GitHubIdentity{ID: 42, Login: "new-login"}, last); err != nil {
		t.Fatal(err)
	}
	report, err := store.Usage(context.Background(), 1, last)
	if err != nil {
		t.Fatal(err)
	}
	if report.DAU != 1 || report.WAU != 1 || len(report.Days) != 1 || report.Days[0].Day != "2026-08-31" {
		t.Fatalf("report = %#v", report)
	}
	if len(report.Days[0].Users) != 1 {
		t.Fatalf("users = %#v", report.Days[0].Users)
	}
	user := report.Days[0].Users[0]
	if user.ID != 42 || user.Login != "new-login" || user.Sessions != 2 {
		t.Fatalf("user = %#v", user)
	}
	if user.FirstSeenAt != first.UTC().Format(time.RFC3339Nano) || user.LastSeenAt != last.UTC().Format(time.RFC3339Nano) {
		t.Fatalf("activity bounds = %s–%s", user.FirstSeenAt, user.LastSeenAt)
	}
}

func TestUsageDAUAndWAUUseUTCDateBoundaries(t *testing.T) {
	store := newUsageStore(t)
	now := time.Date(2026, 8, 31, 0, 15, 0, 0, time.UTC)
	for _, activity := range []struct {
		identity GitHubIdentity
		at       time.Time
	}{
		{GitHubIdentity{ID: 1, Login: "today"}, now},
		{GitHubIdentity{ID: 1, Login: "today"}, now.AddDate(0, 0, -6)},
		{GitHubIdentity{ID: 2, Login: "week-boundary"}, now.AddDate(0, 0, -6)},
		{GitHubIdentity{ID: 3, Login: "outside-week"}, now.AddDate(0, 0, -7)},
	} {
		if err := store.RecordActivity(context.Background(), activity.identity, activity.at); err != nil {
			t.Fatal(err)
		}
	}
	report, err := store.Usage(context.Background(), 8, now)
	if err != nil {
		t.Fatal(err)
	}
	if report.DAU != 1 {
		t.Fatalf("DAU = %d, want 1", report.DAU)
	}
	if report.WAU != 2 {
		t.Fatalf("WAU = %d, want 2", report.WAU)
	}
	if len(report.Days) != 8 || report.Days[6].Day != "2026-08-25" || len(report.Days[6].Users) != 2 || report.Days[7].Day != "2026-08-24" || len(report.Days[7].Users) != 1 {
		t.Fatalf("days = %#v", report.Days)
	}
}

func TestCleanupKeepsExactlyNinetyUsageDatesAndReturnsMarkerCount(t *testing.T) {
	store := newUsageStore(t)
	now := time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC)
	if _, err := store.Append(context.Background(), Marker{
		TS: now.Add(-8 * 24 * time.Hour).UnixMilli(), Repo: "owner/repo", Event: "push",
	}); err != nil {
		t.Fatal(err)
	}
	for _, activity := range []struct {
		id int64
		at time.Time
	}{
		{id: 89, at: now.AddDate(0, 0, -89)},
		{id: 90, at: now.AddDate(0, 0, -90)},
	} {
		if err := store.RecordActivity(context.Background(), GitHubIdentity{ID: activity.id, Login: "user"}, activity.at); err != nil {
			t.Fatal(err)
		}
	}
	deletedMarkers, err := store.cleanup(context.Background(), now)
	if err != nil {
		t.Fatal(err)
	}
	if deletedMarkers != 1 {
		t.Fatalf("deleted markers = %d, want 1", deletedMarkers)
	}
	var count int
	var oldestDay string
	if err := store.db.QueryRow(`SELECT COUNT(*), MIN(day) FROM usage_daily`).Scan(&count, &oldestDay); err != nil {
		t.Fatal(err)
	}
	if count != 1 || oldestDay != now.AddDate(0, 0, -89).Format(time.DateOnly) {
		t.Fatalf("usage rows = %d, oldest day = %s", count, oldestDay)
	}
}
