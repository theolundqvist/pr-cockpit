package relay

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/gorilla/websocket"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newTestRelay(t *testing.T, github http.Handler) (*Server, *Store) {
	t.Helper()
	githubServer := httptest.NewServer(github)
	t.Cleanup(githubServer.Close)
	store, err := OpenStore(filepath.Join(t.TempDir(), "relay.db"), 7*24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	server, err := NewServer(store, Config{WebhookSecret: "secret", GitHubAPIURL: githubServer.URL, HTTPClient: githubServer.Client()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(server.Shutdown)
	return server, store
}

func githubAccess(handler func(*http.Request) int) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.WriteHeader(handler(request))
	})
}
func testTicket(repos map[string]struct{}) ticketSession {
	return ticketSession{
		principal: "test-principal", repos: repos,
		admissionExpires: time.Now().Add(time.Minute), authExpires: time.Now().Add(authTTL),
	}
}

func TestRejectsInvalidWebhookSignature(t *testing.T) {
	server, store := newTestRelay(t, githubAccess(func(*http.Request) int { return http.StatusOK }))
	body := []byte(`{"repository":{"full_name":"owner/repo"}}`)
	request := httptest.NewRequest(http.MethodPost, "/github", bytes.NewReader(body))
	request.Header.Set("X-Hub-Signature-256", "sha256=00")
	request.Header.Set("X-GitHub-Event", "push")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.Code)
	}
	latest, _, err := store.LatestBounds(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if latest != 0 {
		t.Fatalf("latest = %d, rejected webhook was stored", latest)
	}
}

func TestCursorBaselineReplayAndReset(t *testing.T) {
	server, store := newTestRelay(t, githubAccess(func(*http.Request) int { return http.StatusOK }))
	first, err := server.publish(context.Background(), Marker{TS: time.Now().UnixMilli(), Repo: "owner/repo", Event: "push"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := server.publish(context.Background(), Marker{TS: time.Now().UnixMilli(), Repo: "owner/repo", Event: "pull_request"})
	if err != nil {
		t.Fatal(err)
	}
	repos := map[string]struct{}{"owner/repo": {}}
	baseline, replay, initial, err := server.subscribe(context.Background(), testTicket(repos), 0, false)
	if err != nil {
		t.Fatal(err)
	}
	server.unsubscribe(baseline)
	if initial.Type != "ready" || initial.Latest != second.Seq || len(replay) != 0 {
		t.Fatalf("baseline = %#v replay=%d", initial, len(replay))
	}
	subscription, replay, initial, err := server.subscribe(context.Background(), testTicket(repos), first.Seq, true)
	if err != nil {
		t.Fatal(err)
	}
	server.unsubscribe(subscription)
	if initial.Type != "ready" || len(replay) != 1 || replay[0].Seq != second.Seq {
		t.Fatalf("replay initial=%#v markers=%#v", initial, replay)
	}
	if _, err := store.db.Exec(`DELETE FROM markers WHERE seq = ?`, first.Seq); err != nil {
		t.Fatal(err)
	}
	reset, replay, initial, err := server.subscribe(context.Background(), testTicket(repos), 0, true)
	if err != nil {
		t.Fatal(err)
	}
	server.unsubscribe(reset)
	if initial.Type != "reset" || initial.Latest != second.Seq || len(replay) != 0 {
		t.Fatalf("retention reset = %#v replay=%d", initial, len(replay))
	}
	future, _, initial, err := server.subscribe(context.Background(), testTicket(repos), second.Seq+100, true)
	if err != nil {
		t.Fatal(err)
	}
	server.unsubscribe(future)
	if initial.Type != "reset" {
		t.Fatalf("future cursor frame = %q, want reset", initial.Type)
	}
}

func TestEventsFilterUnreadableRepositories(t *testing.T) {
	server, _ := newTestRelay(t, githubAccess(func(request *http.Request) int {
		if request.URL.Path == "/repos/owner/allowed" && request.Header.Get("Authorization") == "Bearer token" {
			return http.StatusOK
		}
		return http.StatusNotFound
	}))
	allowed, err := server.publish(context.Background(), Marker{TS: time.Now().UnixMilli(), Repo: "owner/allowed", Event: "push"})
	if err != nil {
		t.Fatal(err)
	}
	denied, err := server.publish(context.Background(), Marker{TS: time.Now().UnixMilli(), Repo: "owner/denied", Event: "push"})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/events?since=0", nil)
	request.Header.Set("Authorization", "Bearer token")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	var payload struct {
		Latest int64    `json:"latest"`
		Events []Marker `json:"events"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Latest != denied.Seq || len(payload.Events) != 1 || payload.Events[0].Seq != allowed.Seq {
		t.Fatalf("response = %#v", payload)
	}
}

func TestReplayToLiveOrdering(t *testing.T) {
	server, _ := newTestRelay(t, githubAccess(func(*http.Request) int { return http.StatusOK }))
	first, err := server.publish(context.Background(), Marker{TS: time.Now().UnixMilli(), Repo: "owner/repo", Event: "push"})
	if err != nil {
		t.Fatal(err)
	}
	subscription, replay, initial, err := server.subscribe(context.Background(), testTicket(map[string]struct{}{"owner/repo": {}}), 0, true)
	if err != nil {
		t.Fatal(err)
	}
	defer server.unsubscribe(subscription)
	second, err := server.publish(context.Background(), Marker{TS: time.Now().UnixMilli(), Repo: "owner/repo", Event: "pull_request"})
	if err != nil {
		t.Fatal(err)
	}
	if initial.Type != "ready" || len(replay) != 1 || replay[0].Seq != first.Seq {
		t.Fatalf("replay = %#v, initial = %#v", replay, initial)
	}
	select {
	case live := <-subscription.queue:
		if live.Seq != second.Seq || live.Seq != replay[0].Seq+1 {
			t.Fatalf("live seq = %d after replay seq = %d", live.Seq, replay[0].Seq)
		}
	case <-time.After(time.Second):
		t.Fatal("live marker was not delivered")
	}
}

func TestSessionAuthorizesReadableRepoWithoutCoverage(t *testing.T) {
	server, _ := newTestRelay(t, githubAccess(func(request *http.Request) int {
		if request.URL.Path == "/repos/owner/readable" {
			return http.StatusOK
		}
		return http.StatusNotFound
	}))
	body := []byte(`{"repos":["owner/readable","owner/unreadable"]}`)
	request := httptest.NewRequest(http.MethodPost, "/session", bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer token")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	var payload struct {
		Ticket    string          `json:"ticket"`
		ExpiresAt int64           `json:"expiresAt"`
		Repos     map[string]bool `json:"repos"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	session, ok := server.tickets.Consume(payload.Ticket)
	if !ok {
		t.Fatal("session ticket was not issued")
	}
	if _, ok := session.repos["owner/readable"]; !ok {
		t.Fatal("readable repository missing from ticket without coverage")
	}
	if _, ok := session.repos["owner/unreadable"]; ok {
		t.Fatal("unreadable repository present in ticket")
	}
	if payload.Repos["owner/readable"] || payload.Repos["owner/unreadable"] {
		t.Fatalf("coverage = %#v, want false without persisted coverage", payload.Repos)
	}
	if payload.ExpiresAt < time.Now().Add(14*time.Minute).UnixMilli() || payload.ExpiresAt > time.Now().Add(authTTL).UnixMilli() {
		t.Fatalf("authorization expiry = %d", payload.ExpiresAt)
	}
	if session.authExpires.UnixMilli() != payload.ExpiresAt {
		t.Fatalf("ticket expiry = %d, response expiry = %d", session.authExpires.UnixMilli(), payload.ExpiresAt)
	}
}
func TestSessionRejectsEmptyAndUnreadableRepoSets(t *testing.T) {
	server, _ := newTestRelay(t, githubAccess(func(*http.Request) int { return http.StatusNotFound }))
	for name, testCase := range map[string]struct {
		body string
		want int
	}{
		"empty":      {body: `{"repos":[" "]}`, want: http.StatusBadRequest},
		"unreadable": {body: `{"repos":["owner/repo"]}`, want: http.StatusForbidden},
	} {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/session", bytes.NewBufferString(testCase.body))
			request.Header.Set("Authorization", "Bearer token")
			response := httptest.NewRecorder()
			server.Handler().ServeHTTP(response, request)
			if response.Code != testCase.want {
				t.Fatalf("status = %d, want %d", response.Code, testCase.want)
			}
		})
	}
}
func TestSessionAuthFailureReturnsServiceUnavailable(t *testing.T) {
	server, _ := newTestRelay(t, githubAccess(func(*http.Request) int { return http.StatusInternalServerError }))
	request := httptest.NewRequest(http.MethodPost, "/session", bytes.NewBufferString(`{"repos":["owner/repo"]}`))
	request.Header.Set("Authorization", "Bearer token")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", response.Code)
	}
}

func TestExpiredAuthorizationCannotBeConsumed(t *testing.T) {
	tickets := NewTickets()
	ticket, err := tickets.Issue("principal", []string{"owner/repo"}, time.Now().Add(-time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := tickets.Consume(ticket); ok {
		t.Fatal("ticket with expired authorization was accepted")
	}
}
func TestStreamClosesWhenAuthorizationExpires(t *testing.T) {
	server, _ := newTestRelay(t, githubAccess(func(*http.Request) int { return http.StatusOK }))
	authExpires := time.Now().Add(250 * time.Millisecond)
	ticket, err := server.tickets.Issue("principal", []string{"owner/repo"}, authExpires)
	if err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(server.Handler())
	defer httpServer.Close()
	connection, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(httpServer.URL, "http")+"/stream?ticket="+ticket, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	var ready readyFrame
	if err := connection.ReadJSON(&ready); err != nil {
		t.Fatal(err)
	}
	connection.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err := connection.ReadMessage(); err == nil {
		t.Fatal("stream remained open after authorization expiry")
	} else if closeError, ok := err.(*websocket.CloseError); !ok || closeError.Code != websocket.ClosePolicyViolation {
		t.Fatalf("close error = %v", err)
	}
}

func TestSubscriberPrincipalCapReleasesOnDisconnect(t *testing.T) {
	server, _ := newTestRelay(t, githubAccess(func(*http.Request) int { return http.StatusOK }))
	session := testTicket(map[string]struct{}{"owner/repo": {}})
	subscribers := make([]*subscriber, 0, maxPrincipalStreams)
	for range maxPrincipalStreams {
		subscription, _, _, err := server.subscribe(context.Background(), session, 0, false)
		if err != nil {
			t.Fatal(err)
		}
		subscribers = append(subscribers, subscription)
	}
	if _, _, _, err := server.subscribe(context.Background(), session, 0, false); !errors.Is(err, errSubscriberCapacity) {
		t.Fatalf("fifth stream error = %v", err)
	}
	server.unsubscribe(subscribers[0])
	replacement, _, _, err := server.subscribe(context.Background(), session, 0, false)
	if err != nil {
		t.Fatalf("replacement stream: %v", err)
	}
	server.unsubscribe(replacement)
	for _, subscription := range subscribers[1:] {
		server.unsubscribe(subscription)
	}
}

func TestBodyReaderCapacityFailsFast(t *testing.T) {
	server, _ := newTestRelay(t, githubAccess(func(*http.Request) int { return http.StatusOK }))
	for range bodyReaderLimit {
		server.bodySlots <- struct{}{}
	}
	defer func() {
		for range bodyReaderLimit {
			<-server.bodySlots
		}
	}()
	request := httptest.NewRequest(http.MethodPost, "/github", bytes.NewBufferString("{}"))
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", response.Code)
	}
}

func TestGlobalSubscriberCapFailsFast(t *testing.T) {
	server, _ := newTestRelay(t, githubAccess(func(*http.Request) int { return http.StatusOK }))
	for range maxSubscribers {
		server.subscribers[&subscriber{done: make(chan struct{})}] = struct{}{}
	}
	if _, _, _, err := server.subscribe(context.Background(), testTicket(map[string]struct{}{"owner/repo": {}}), 0, false); !errors.Is(err, errSubscriberCapacity) {
		t.Fatalf("global stream cap error = %v", err)
	}
	clear(server.subscribers)
}

func TestPublishThrottlesRetentionCleanup(t *testing.T) {
	server, store := newTestRelay(t, githubAccess(func(*http.Request) int { return http.StatusOK }))
	old := time.Now().Add(-8 * 24 * time.Hour).UnixMilli()
	if _, err := store.db.Exec(`INSERT INTO markers(ts, repo, event) VALUES(?, 'owner/repo', 'old')`, old); err != nil {
		t.Fatal(err)
	}
	server.cleanupAfter.Store(time.Now().Add(time.Hour).UnixNano())
	if _, err := server.publish(context.Background(), Marker{TS: time.Now().UnixMilli(), Repo: "owner/repo", Event: "new"}); err != nil {
		t.Fatal(err)
	}
	var retained int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM markers WHERE event = 'old'`).Scan(&retained); err != nil {
		t.Fatal(err)
	}
	if retained != 1 {
		t.Fatal("cleanup ran before its throttle expired")
	}
	server.cleanupAfter.Store(0)
	if _, err := server.publish(context.Background(), Marker{TS: time.Now().UnixMilli(), Repo: "owner/repo", Event: "newer"}); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM markers WHERE event = 'old'`).Scan(&retained); err != nil {
		t.Fatal(err)
	}
	if retained != 0 {
		t.Fatal("expired marker remained after scheduled cleanup")
	}
}

func TestReplaySnapshotSurvivesConcurrentCleanup(t *testing.T) {
	_, store := newTestRelay(t, githubAccess(func(*http.Request) int { return http.StatusOK }))
	stored, err := store.Append(context.Background(), Marker{
		TS: time.Now().Add(-8 * 24 * time.Hour).UnixMilli(), Repo: "owner/repo", Event: "push",
	})
	if err != nil {
		t.Fatal(err)
	}
	transaction, err := store.db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer transaction.Rollback()
	latest, _, err := latestBounds(context.Background(), transaction)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Cleanup(context.Background()); err != nil {
		t.Fatal(err)
	}
	markers, err := replay(context.Background(), transaction, 0, maxReplayBacklog+1)
	if err != nil {
		t.Fatal(err)
	}
	if latest != stored.Seq || len(markers) != 1 || markers[0].Seq != stored.Seq {
		t.Fatalf("snapshot latest=%d markers=%#v", latest, markers)
	}
}

func TestOversizedReplayBacklogResets(t *testing.T) {
	server, store := newTestRelay(t, githubAccess(func(*http.Request) int { return http.StatusOK }))
	tx, err := store.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	statement, err := tx.Prepare(`INSERT INTO markers(ts, repo, event) VALUES(?, 'owner/repo', 'push')`)
	if err != nil {
		tx.Rollback()
		t.Fatal(err)
	}
	now := time.Now().UnixMilli()
	for range maxReplayBacklog + 1 {
		if _, err := statement.Exec(now); err != nil {
			statement.Close()
			tx.Rollback()
			t.Fatal(err)
		}
	}
	statement.Close()
	if _, err := tx.Exec(`UPDATE relay_state SET latest_seq = (SELECT MAX(seq) FROM markers) WHERE singleton = 1`); err != nil {
		tx.Rollback()
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	subscription, replay, initial, err := server.subscribe(context.Background(), testTicket(map[string]struct{}{"owner/repo": {}}), 0, true)
	if err != nil {
		t.Fatal(err)
	}
	server.unsubscribe(subscription)
	if initial.Type != "reset" || len(replay) != 0 {
		t.Fatalf("oversized backlog frame = %#v replay=%d", initial, len(replay))
	}
}

func TestValidWebhookSignature(t *testing.T) {
	body := []byte("payload")
	mac := hmac.New(sha256.New, []byte("secret"))
	mac.Write(body)
	if !validSignature([]byte("secret"), body, "sha256="+hex.EncodeToString(mac.Sum(nil))) {
		t.Fatal("valid signature rejected")
	}
}
