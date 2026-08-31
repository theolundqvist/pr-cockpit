package relay

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

const replayPage = 500

type Store struct {
	db        *sql.DB
	retention time.Duration
}

func OpenStore(path string, retention time.Duration) (*Store, error) {
	if retention <= 0 {
		return nil, errors.New("retention must be positive")
	}
	if path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			return nil, fmt.Errorf("create database directory: %w", err)
		}
	}
	dsn := path
	if path != ":memory:" {
		dsn = "file:" + path
	}
	separator := "?"
	if strings.Contains(dsn, "?") {
		separator = "&"
	}
	db, err := sql.Open("sqlite3", dsn+separator+"_journal_mode=WAL&_busy_timeout=5000&_synchronous=NORMAL&_foreign_keys=on")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(8)
	store := &Store{db: db, retention: retention}
	if err := store.migrate(context.Background()); err != nil {
		db.Close()
		return nil, err
	}
	if _, err := store.Cleanup(context.Background()); err != nil {
		db.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS relay_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  latest_seq INTEGER NOT NULL
);
INSERT OR IGNORE INTO relay_state(singleton, latest_seq) VALUES(1, 0);
CREATE TABLE IF NOT EXISTS markers (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER,
  event TEXT NOT NULL,
  run_json TEXT,
  job_json TEXT
);
CREATE INDEX IF NOT EXISTS markers_retention_idx ON markers(ts, seq);
CREATE TABLE IF NOT EXISTS legacy_forward_repos (
  repo TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS installation_coverage (
  owner TEXT PRIMARY KEY,
  all_repos INTEGER NOT NULL CHECK (all_repos IN (0, 1))
);
CREATE TABLE IF NOT EXISTS installation_repos (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  PRIMARY KEY(owner, repo),
  FOREIGN KEY(owner) REFERENCES installation_coverage(owner) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT NOT NULL,
  github_user_id INTEGER NOT NULL,
  login TEXT NOT NULL,
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL,
  sessions INTEGER NOT NULL,
  PRIMARY KEY(day, github_user_id)
);
CREATE TABLE IF NOT EXISTS usage_repos (
  repo TEXT PRIMARY KEY,
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL,
  sessions INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_repo_daily (
  day TEXT NOT NULL,
  github_user_id INTEGER NOT NULL,
  repo TEXT NOT NULL,
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL,
  sessions INTEGER NOT NULL,
  PRIMARY KEY(day, github_user_id, repo)
);
`)
	return err
}

func (s *Store) Append(ctx context.Context, marker Marker) (Marker, error) {
	runJSON, err := nullableJSON(marker.Run)
	if err != nil {
		return Marker{}, err
	}
	jobJSON, err := nullableJSON(marker.Job)
	if err != nil {
		return Marker{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Marker{}, err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx,
		`INSERT INTO markers(ts, repo, number, event, run_json, job_json) VALUES(?, ?, ?, ?, ?, ?)`,
		marker.TS, marker.Repo, marker.Number, marker.Event, runJSON, jobJSON)
	if err != nil {
		return Marker{}, err
	}
	marker.Seq, err = result.LastInsertId()
	if err != nil {
		return Marker{}, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE relay_state SET latest_seq = ? WHERE singleton = 1`, marker.Seq); err != nil {
		return Marker{}, err
	}
	owner := repoOwner(marker.Repo)
	if owner != "" {
		if _, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO installation_coverage(owner, all_repos) VALUES(?, 0)`, owner); err != nil {
			return Marker{}, err
		}
		if _, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO installation_repos(owner, repo) VALUES(?, ?)`, owner, marker.Repo); err != nil {
			return Marker{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return Marker{}, err
	}
	return marker, nil
}

func (s *Store) RememberLegacyForwardRepo(ctx context.Context, repo string) error {
	_, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO legacy_forward_repos(repo) VALUES(?)`, repo)
	return err
}

func (s *Store) IsLegacyForwardRepo(ctx context.Context, repo string) (bool, error) {
	var present int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM legacy_forward_repos WHERE repo = ?`, repo).Scan(&present)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return present == 1, err
}

func nullableJSON(value any) (any, error) {
	if value == nil || (reflect.ValueOf(value).Kind() == reflect.Pointer && reflect.ValueOf(value).IsNil()) {
		return nil, nil
	}
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return string(data), nil
}

type queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func (s *Store) LatestBounds(ctx context.Context) (latest, oldest int64, err error) {
	return latestBounds(ctx, s.db)
}

func latestBounds(ctx context.Context, database queryer) (latest, oldest int64, err error) {
	var first sql.NullInt64
	err = database.QueryRowContext(ctx, `
SELECT latest_seq, (SELECT MIN(seq) FROM markers)
FROM relay_state
WHERE singleton = 1`).Scan(&latest, &first)
	if err != nil {
		return 0, 0, err
	}
	if first.Valid {
		oldest = first.Int64
	}
	return latest, oldest, nil
}

func (s *Store) Replay(ctx context.Context, since int64, limit int) ([]Marker, error) {
	return replay(ctx, s.db, since, limit)
}

func replay(ctx context.Context, database queryer, since int64, limit int) ([]Marker, error) {
	query := `SELECT seq, ts, repo, number, event, run_json, job_json FROM markers WHERE seq > ? ORDER BY seq ASC`
	args := []any{since}
	if limit > 0 {
		query += ` LIMIT ?`
		args = append(args, limit)
	}
	rows, err := database.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	markers := make([]Marker, 0)
	for rows.Next() {
		marker, err := scanMarker(rows)
		if err != nil {
			return nil, err
		}
		markers = append(markers, marker)
	}
	return markers, rows.Err()
}

func (s *Store) ReplaySnapshot(ctx context.Context, since int64, limit int) (latest, oldest int64, markers []Marker, err error) {
	transaction, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, nil, err
	}
	defer transaction.Rollback()
	latest, oldest, err = latestBounds(ctx, transaction)
	if err != nil {
		return 0, 0, nil, err
	}
	markers, err = replay(ctx, transaction, since, limit)
	if err != nil {
		return 0, 0, nil, err
	}
	if err = transaction.Commit(); err != nil {
		return 0, 0, nil, err
	}
	return latest, oldest, markers, nil
}

type scanner interface{ Scan(...any) error }

func scanMarker(row scanner) (Marker, error) {
	var marker Marker
	var number sql.NullInt64
	var runJSON, jobJSON sql.NullString
	if err := row.Scan(&marker.Seq, &marker.TS, &marker.Repo, &number, &marker.Event, &runJSON, &jobJSON); err != nil {
		return Marker{}, err
	}
	if number.Valid {
		marker.Number = &number.Int64
	}
	if runJSON.Valid {
		marker.Run = &CompactRun{}
		if err := json.Unmarshal([]byte(runJSON.String), marker.Run); err != nil {
			return Marker{}, err
		}
	}
	if jobJSON.Valid {
		marker.Job = &CompactJob{}
		if err := json.Unmarshal([]byte(jobJSON.String), marker.Job); err != nil {
			return Marker{}, err
		}
	}
	return marker, nil
}

func (s *Store) Cleanup(ctx context.Context) (int64, error) {
	return s.cleanup(ctx, time.Now().UTC())
}

func (s *Store) cleanup(ctx context.Context, now time.Time) (int64, error) {
	cutoff := now.Add(-s.retention).UnixMilli()
	result, err := s.db.ExecContext(ctx, `DELETE FROM markers WHERE ts < ?`, cutoff)
	if err != nil {
		return 0, err
	}
	deletedMarkers, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}

	oldestUsageDay := now.AddDate(0, 0, -89).Format(time.DateOnly)
	if _, err := s.db.ExecContext(ctx, `DELETE FROM usage_daily WHERE day < ?`, oldestUsageDay); err != nil {
		return deletedMarkers, err
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM usage_repo_daily WHERE day < ?`, oldestUsageDay); err != nil {
		return deletedMarkers, err
	}
	return deletedMarkers, nil
}

func (s *Store) CoverageFor(ctx context.Context, repos []string) (map[string]bool, error) {
	coverage := make(map[string]bool, len(repos))
	for _, repo := range repos {
		owner := repoOwner(repo)
		var all bool
		err := s.db.QueryRowContext(ctx, `SELECT all_repos FROM installation_coverage WHERE owner = ?`, owner).Scan(&all)
		if errors.Is(err, sql.ErrNoRows) {
			coverage[repo] = false
			continue
		}
		if err != nil {
			return nil, err
		}
		if all {
			coverage[repo] = true
			continue
		}
		var present int
		err = s.db.QueryRowContext(ctx, `SELECT 1 FROM installation_repos WHERE owner = ? AND repo = ?`, owner, repo).Scan(&present)
		coverage[repo] = err == nil
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
	}
	return coverage, nil
}

func (s *Store) UpdateInstallation(ctx context.Context, event string, payload webhookPayload) error {
	if payload.Installation == nil || payload.Installation.Account == nil || payload.Installation.Account.Login == "" {
		return nil
	}
	owner := payload.Installation.Account.Login
	all := payload.Installation.RepositorySelection == "all"
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	switch event {
	case "installation":
		switch payload.Action {
		case "created", "unsuspend":
			if _, err = tx.ExecContext(ctx, `INSERT INTO installation_coverage(owner, all_repos) VALUES(?, ?) ON CONFLICT(owner) DO UPDATE SET all_repos=excluded.all_repos`, owner, all); err != nil {
				return err
			}
			if _, err = tx.ExecContext(ctx, `DELETE FROM installation_repos WHERE owner = ?`, owner); err != nil {
				return err
			}
			for _, repo := range payload.Repositories {
				if _, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO installation_repos(owner, repo) VALUES(?, ?)`, owner, repo.FullName); err != nil {
					return err
				}
			}
		case "deleted", "suspend":
			if _, err = tx.ExecContext(ctx, `DELETE FROM installation_coverage WHERE owner = ?`, owner); err != nil {
				return err
			}
		default:
			return nil
		}
	case "installation_repositories":
		switch payload.Action {
		case "added", "removed":
			if _, err = tx.ExecContext(ctx, `INSERT INTO installation_coverage(owner, all_repos) VALUES(?, ?) ON CONFLICT(owner) DO UPDATE SET all_repos=excluded.all_repos`, owner, all); err != nil {
				return err
			}
			for _, repo := range payload.RepositoriesRemoved {
				if _, err = tx.ExecContext(ctx, `DELETE FROM installation_repos WHERE owner = ? AND repo = ?`, owner, repo.FullName); err != nil {
					return err
				}
			}
			for _, repo := range payload.RepositoriesAdded {
				if _, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO installation_repos(owner, repo) VALUES(?, ?)`, owner, repo.FullName); err != nil {
					return err
				}
			}
		default:
			return nil
		}
	default:
		return nil
	}
	return tx.Commit()
}

func repoOwner(repo string) string {
	owner, _, ok := strings.Cut(repo, "/")
	if !ok {
		return ""
	}
	return owner
}

type UsageUserRepo struct {
	Name     string `json:"name"`
	Sessions int64  `json:"sessions"`
}

type UsageUser struct {
	ID          int64           `json:"id"`
	Login       string          `json:"login"`
	FirstSeenAt string          `json:"firstSeenAt"`
	LastSeenAt  string          `json:"lastSeenAt"`
	Sessions    int64           `json:"sessions"`
	Repos       []UsageUserRepo `json:"repos"`
}

type UsageDay struct {
	Day   string      `json:"day"`
	Users []UsageUser `json:"users"`
}

type UsageRepo struct {
	Name        string `json:"name"`
	FirstSeenAt string `json:"firstSeenAt"`
	LastSeenAt  string `json:"lastSeenAt"`
	Sessions    int64  `json:"sessions"`
	DAU         int64  `json:"dau"`
	WAU         int64  `json:"wau"`
}

type UsageReport struct {
	GeneratedAt string      `json:"generatedAt"`
	DAU         int64       `json:"dau"`
	WAU         int64       `json:"wau"`
	Days        []UsageDay  `json:"days"`
	Repos       []UsageRepo `json:"repos"`
}

func (s *Store) RecordActivity(ctx context.Context, identity GitHubIdentity, repos []string, at time.Time) error {
	at = at.UTC()
	day := at.Format(time.DateOnly)
	atMS := at.UnixMilli()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `
INSERT INTO usage_daily(day, github_user_id, login, first_seen_ms, last_seen_ms, sessions)
VALUES(?, ?, ?, ?, ?, 1)
ON CONFLICT(day, github_user_id) DO UPDATE SET
  login = excluded.login,
  first_seen_ms = MIN(usage_daily.first_seen_ms, excluded.first_seen_ms),
  last_seen_ms = MAX(usage_daily.last_seen_ms, excluded.last_seen_ms),
  sessions = usage_daily.sessions + 1
`, day, identity.ID, identity.Login, atMS, atMS); err != nil {
		return err
	}
	for _, repo := range repos {
		if _, err := tx.ExecContext(ctx, `
INSERT INTO usage_repos(repo, first_seen_ms, last_seen_ms, sessions)
VALUES(?, ?, ?, 1)
ON CONFLICT(repo) DO UPDATE SET
  first_seen_ms = MIN(usage_repos.first_seen_ms, excluded.first_seen_ms),
  last_seen_ms = MAX(usage_repos.last_seen_ms, excluded.last_seen_ms),
  sessions = usage_repos.sessions + 1
`, repo, atMS, atMS); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO usage_repo_daily(day, github_user_id, repo, first_seen_ms, last_seen_ms, sessions)
VALUES(?, ?, ?, ?, ?, 1)
ON CONFLICT(day, github_user_id, repo) DO UPDATE SET
  first_seen_ms = MIN(usage_repo_daily.first_seen_ms, excluded.first_seen_ms),
  last_seen_ms = MAX(usage_repo_daily.last_seen_ms, excluded.last_seen_ms),
  sessions = usage_repo_daily.sessions + 1
`, day, identity.ID, repo, atMS, atMS); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) Usage(ctx context.Context, days int, now time.Time) (UsageReport, error) {
	now = now.UTC()
	today := now.Format(time.DateOnly)
	weekStart := now.AddDate(0, 0, -6).Format(time.DateOnly)
	report := UsageReport{
		GeneratedAt: now.Format(time.RFC3339Nano),
		Days:        make([]UsageDay, days),
		Repos:       []UsageRepo{},
	}
	dayByName := make(map[string]*UsageDay, days)
	for offset := range days {
		day := now.AddDate(0, 0, -offset).Format(time.DateOnly)
		report.Days[offset] = UsageDay{Day: day, Users: []UsageUser{}}
		dayByName[day] = &report.Days[offset]
	}
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM usage_daily WHERE day = ?`, today).Scan(&report.DAU); err != nil {
		return UsageReport{}, err
	}
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(DISTINCT github_user_id) FROM usage_daily WHERE day BETWEEN ? AND ?`, weekStart, today).Scan(&report.WAU); err != nil {
		return UsageReport{}, err
	}
	start := now.AddDate(0, 0, -(days - 1)).Format(time.DateOnly)
	rows, err := s.db.QueryContext(ctx, `
SELECT day, github_user_id, login, first_seen_ms, last_seen_ms, sessions
FROM usage_daily
WHERE day BETWEEN ? AND ?
ORDER BY day DESC, github_user_id
`, start, today)
	if err != nil {
		return UsageReport{}, err
	}
	for rows.Next() {
		var day string
		var user UsageUser
		var firstSeenMS, lastSeenMS int64
		if err := rows.Scan(&day, &user.ID, &user.Login, &firstSeenMS, &lastSeenMS, &user.Sessions); err != nil {
			rows.Close()
			return UsageReport{}, err
		}
		current := dayByName[day]
		if current == nil {
			continue
		}
		user.FirstSeenAt = time.UnixMilli(firstSeenMS).UTC().Format(time.RFC3339Nano)
		user.LastSeenAt = time.UnixMilli(lastSeenMS).UTC().Format(time.RFC3339Nano)
		user.Repos = []UsageUserRepo{}
		current.Users = append(current.Users, user)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return UsageReport{}, err
	}
	rows.Close()

	type userKey struct {
		day string
		id  int64
	}
	users := make(map[userKey]*UsageUser)
	for dayIndex := range report.Days {
		for userIndex := range report.Days[dayIndex].Users {
			user := &report.Days[dayIndex].Users[userIndex]
			users[userKey{day: report.Days[dayIndex].Day, id: user.ID}] = user
		}
	}
	rows, err = s.db.QueryContext(ctx, `
SELECT day, github_user_id, repo, sessions
FROM usage_repo_daily
WHERE day BETWEEN ? AND ?
ORDER BY day DESC, github_user_id, repo
`, start, today)
	if err != nil {
		return UsageReport{}, err
	}
	for rows.Next() {
		var day, repo string
		var userID, sessions int64
		if err := rows.Scan(&day, &userID, &repo, &sessions); err != nil {
			rows.Close()
			return UsageReport{}, err
		}
		if user := users[userKey{day: day, id: userID}]; user != nil {
			user.Repos = append(user.Repos, UsageUserRepo{Name: repo, Sessions: sessions})
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return UsageReport{}, err
	}
	rows.Close()

	rows, err = s.db.QueryContext(ctx, `
SELECT r.repo, r.first_seen_ms, r.last_seen_ms, r.sessions,
       COUNT(DISTINCT CASE WHEN d.day = ? THEN d.github_user_id END),
       COUNT(DISTINCT CASE WHEN d.day BETWEEN ? AND ? THEN d.github_user_id END)
FROM usage_repos r
LEFT JOIN usage_repo_daily d ON d.repo = r.repo AND d.day BETWEEN ? AND ?
GROUP BY r.repo, r.first_seen_ms, r.last_seen_ms, r.sessions
ORDER BY r.last_seen_ms DESC, r.repo
`, today, weekStart, today, weekStart, today)
	if err != nil {
		return UsageReport{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var repo UsageRepo
		var firstSeenMS, lastSeenMS int64
		if err := rows.Scan(&repo.Name, &firstSeenMS, &lastSeenMS, &repo.Sessions, &repo.DAU, &repo.WAU); err != nil {
			return UsageReport{}, err
		}
		repo.FirstSeenAt = time.UnixMilli(firstSeenMS).UTC().Format(time.RFC3339Nano)
		repo.LastSeenAt = time.UnixMilli(lastSeenMS).UTC().Format(time.RFC3339Nano)
		report.Repos = append(report.Repos, repo)
	}
	if err := rows.Err(); err != nil {
		return UsageReport{}, err
	}
	return report, nil
}
