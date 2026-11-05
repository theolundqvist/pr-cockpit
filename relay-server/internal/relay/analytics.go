package relay

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"time"
)

const (
	maxAnalyticsBody             = 64 << 10
	maxAnalyticsEvents           = 200
	maxAnalyticsSubjectDayEvents = 5000
	maxAnalyticsNewSubjects      = 5000
	analyticsPastLimit           = 7 * 24 * time.Hour
	analyticsFutureLimit         = 5 * time.Minute
	analyticsCountsRetentionDays = 180
	analyticsRetentionDays       = 400
)

var (
	validEventName     = regexp.MustCompile(`^[a-z0-9][a-z0-9:._/+-]{0,63}$`)
	validVersion       = regexp.MustCompile(`^[A-Za-z0-9._-]{1,40}$`)
	analyticsKinds     = map[string]bool{"screen": true, "ui": true, "key": true, "step": true, "cli": true}
	analyticsClients   = map[string]bool{"electron": true, "browser": true, "cli": true, "server": true}
	analyticsPlatforms = map[string]bool{"darwin": true, "linux": true, "windows": true, "other": true}
)

type analyticsEvent struct {
	At      int64  `json:"at"`
	Session string `json:"session"`
	Kind    string `json:"kind"`
	Screen  string `json:"screen"`
	Action  string `json:"action"`
	Value   string `json:"value"`
	Client  string `json:"client"`
}

type analyticsBatch struct {
	Install  string           `json:"install"`
	Anon     string           `json:"anon"`
	Ref      string           `json:"ref"`
	Surface  string           `json:"surface"`
	Version  string           `json:"version"`
	Platform string           `json:"platform"`
	Events   []analyticsEvent `json:"events"`
}

func (batch analyticsBatch) subject() string {
	if batch.Surface == "app" {
		return "i:" + batch.Install
	}
	return "a:" + batch.Anon
}

func (batch analyticsBatch) validate() error {
	switch batch.Surface {
	case "app":
		if batch.Install == "" {
			return errors.New("app events require an install id")
		}
	case "site", "script":
		if batch.Anon == "" {
			return errors.New("site and script events require an anon id")
		}
	default:
		return errors.New("invalid surface")
	}
	for _, id := range []string{batch.Install, batch.Anon, batch.Ref} {
		if id != "" && !validInstall.MatchString(id) {
			return errors.New("invalid id")
		}
	}
	if batch.Version != "" && !validVersion.MatchString(batch.Version) {
		return errors.New("invalid version")
	}
	if batch.Platform != "" && !analyticsPlatforms[batch.Platform] {
		return errors.New("invalid platform")
	}
	if len(batch.Events) == 0 || len(batch.Events) > maxAnalyticsEvents {
		return errors.New("between 1 and 200 events are required")
	}
	for _, event := range batch.Events {
		if !analyticsKinds[event.Kind] {
			return errors.New("invalid event kind")
		}
		if !validEventName.MatchString(event.Action) {
			return errors.New("invalid event action")
		}
		for _, name := range []string{event.Screen, event.Value} {
			if name != "" && !validEventName.MatchString(name) {
				return errors.New("invalid event name")
			}
		}
		if event.Client != "" && !analyticsClients[event.Client] {
			return errors.New("invalid event client")
		}
		if event.Session != "" && !validInstall.MatchString(event.Session) {
			return errors.New("invalid event session")
		}
	}
	return nil
}

func (s *Server) handleAnalyticsEvents(response http.ResponseWriter, request *http.Request) {
	release, ok := s.acquireBodyReader(response)
	if !ok {
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(response, request.Body, maxAnalyticsBody))
	release()
	if err != nil {
		http.Error(response, "invalid body", http.StatusBadRequest)
		return
	}
	var batch analyticsBatch
	if err := json.Unmarshal(body, &batch); err != nil {
		http.Error(response, "invalid JSON", http.StatusBadRequest)
		return
	}
	if err := batch.validate(); err != nil {
		http.Error(response, err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.store.RecordAnalytics(request.Context(), batch, s.now()); err != nil {
		s.internalError(response, err)
		return
	}
	s.maybeCleanup(request.Context())
	response.WriteHeader(http.StatusNoContent)
}

// RecordAnalytics stores a validated batch. Batches from a new subject past the per-surface daily
// cap, and events past a subject's daily cap, are dropped without error.
func (s *Store) RecordAnalytics(ctx context.Context, batch analyticsBatch, now time.Time) error {
	now = now.UTC()
	nowMS := now.UnixMilli()
	subject := batch.subject()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var known int
	err = tx.QueryRowContext(ctx, `SELECT 1 FROM analytics_subjects WHERE subject = ?`, subject).Scan(&known)
	if errors.Is(err, sql.ErrNoRows) {
		dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC).UnixMilli()
		var created int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM analytics_subjects WHERE surface = ? AND first_ms >= ?`, batch.Surface, dayStart).Scan(&created); err != nil {
			return err
		}
		if created >= maxAnalyticsNewSubjects {
			return nil
		}
	} else if err != nil {
		return err
	}
	if err := touchAnalyticsSubject(ctx, tx, subject, batch.Surface, nowMS, nullableName(batch.Platform), nullableName(batch.Version), nullableName(batch.Ref)); err != nil {
		return err
	}
	countStmt, err := tx.PrepareContext(ctx, `
INSERT INTO analytics_counts(day, subject, kind, screen, action, value, client, n)
VALUES(?, ?, ?, ?, ?, ?, ?, 1)
ON CONFLICT(day, subject, kind, screen, action, value, client) DO UPDATE SET n = analytics_counts.n + 1
`)
	if err != nil {
		return err
	}
	defer countStmt.Close()
	stepStmt, err := tx.PrepareContext(ctx, `
INSERT INTO analytics_steps(subject, step, first_ms, value)
VALUES(?, ?, ?, ?)
ON CONFLICT(subject, step) DO UPDATE SET first_ms = excluded.first_ms, value = excluded.value
WHERE excluded.first_ms < analytics_steps.first_ms
`)
	if err != nil {
		return err
	}
	defer stepStmt.Close()
	type dayEvents struct{ stored, added int }
	days := make(map[string]*dayEvents)
	oldest, newest := now.Add(-analyticsPastLimit).UnixMilli(), now.Add(analyticsFutureLimit).UnixMilli()
	for _, event := range batch.Events {
		at := event.At
		if at < oldest || at > newest {
			at = nowMS
		}
		day := time.UnixMilli(at).UTC().Format(time.DateOnly)
		current := days[day]
		if current == nil {
			current = &dayEvents{}
			err := tx.QueryRowContext(ctx, `SELECT events FROM analytics_days WHERE day = ? AND subject = ?`, day, subject).Scan(&current.stored)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			days[day] = current
		}
		if current.stored+current.added >= maxAnalyticsSubjectDayEvents {
			continue
		}
		current.added++
		if _, err := countStmt.ExecContext(ctx, day, subject, event.Kind, event.Screen, event.Action, event.Value, event.Client); err != nil {
			return err
		}
		if event.Kind == "step" {
			if _, err := stepStmt.ExecContext(ctx, subject, event.Action, at, event.Value); err != nil {
				return err
			}
		}
	}
	for day, current := range days {
		if current.added == 0 {
			continue
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO analytics_days(day, subject, events) VALUES(?, ?, ?)
ON CONFLICT(day, subject) DO UPDATE SET events = analytics_days.events + excluded.events
`, day, subject, current.added); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// RecordRelayConnection marks an install's relay session: the install's first connection and,
// with a verified GitHub user, the link between that install and the account.
func (s *Store) RecordRelayConnection(ctx context.Context, install string, user *GitHubIdentity, at time.Time) error {
	atMS := at.UnixMilli()
	subject := "i:" + install
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := touchAnalyticsSubject(ctx, tx, subject, "app", atMS, nil, nil, nil); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO analytics_steps(subject, step, first_ms, value) VALUES(?, 'relay-connected', ?, '')
ON CONFLICT(subject, step) DO NOTHING
`, subject, atMS); err != nil {
		return err
	}
	if user != nil {
		if _, err := tx.ExecContext(ctx, `
INSERT INTO analytics_links(install, github_user_id, login, first_ms, last_ms) VALUES(?, ?, ?, ?, ?)
ON CONFLICT(install, github_user_id) DO UPDATE SET
  login = excluded.login,
  first_ms = MIN(analytics_links.first_ms, excluded.first_ms),
  last_ms = MAX(analytics_links.last_ms, excluded.last_ms)
`, install, user.ID, user.Login, atMS, atMS); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func touchAnalyticsSubject(ctx context.Context, tx *sql.Tx, subject, surface string, atMS int64, platform, version, ref *string) error {
	_, err := tx.ExecContext(ctx, `
INSERT INTO analytics_subjects(subject, surface, first_ms, last_ms, platform, version, ref)
VALUES(?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(subject) DO UPDATE SET
  last_ms = MAX(analytics_subjects.last_ms, excluded.last_ms),
  platform = COALESCE(excluded.platform, analytics_subjects.platform),
  version = COALESCE(excluded.version, analytics_subjects.version),
  ref = COALESCE(analytics_subjects.ref, excluded.ref)
`, subject, surface, atMS, atMS, platform, version, ref)
	return err
}

func nullableName(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func cleanupAnalytics(ctx context.Context, database *sql.DB, now time.Time) error {
	countsCutoff := now.AddDate(0, 0, -analyticsCountsRetentionDays).Format(time.DateOnly)
	if _, err := database.ExecContext(ctx, `DELETE FROM analytics_counts WHERE day < ?`, countsCutoff); err != nil {
		return err
	}
	daysCutoff := now.AddDate(0, 0, -analyticsRetentionDays)
	if _, err := database.ExecContext(ctx, `DELETE FROM analytics_days WHERE day < ?`, daysCutoff.Format(time.DateOnly)); err != nil {
		return err
	}
	subjectsCutoff := daysCutoff.UnixMilli()
	if _, err := database.ExecContext(ctx, `
DELETE FROM analytics_links WHERE install IN (
  SELECT substr(subject, 3) FROM analytics_subjects WHERE last_ms < ? AND subject LIKE 'i:%'
)`, subjectsCutoff); err != nil {
		return err
	}
	if _, err := database.ExecContext(ctx, `DELETE FROM analytics_steps WHERE subject IN (SELECT subject FROM analytics_subjects WHERE last_ms < ?)`, subjectsCutoff); err != nil {
		return err
	}
	_, err := database.ExecContext(ctx, `DELETE FROM analytics_subjects WHERE last_ms < ?`, subjectsCutoff)
	return err
}
