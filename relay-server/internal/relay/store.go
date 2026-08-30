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
	cutoff := time.Now().Add(-s.retention).UnixMilli()
	result, err := s.db.ExecContext(ctx, `DELETE FROM markers WHERE ts < ?`, cutoff)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
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
