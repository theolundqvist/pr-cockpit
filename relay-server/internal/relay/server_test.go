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
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func newConfiguredRelay(t *testing.T, config Config) (*Server, *Store) {
	t.Helper()
	store, err := OpenStore(filepath.Join(t.TempDir(), "relay.db"), 7*24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	server, err := NewServer(store, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(server.Shutdown)
	return server, store
}

func newTestRelay(t *testing.T, github http.Handler) (*Server, *Store) {
	t.Helper()
	githubServer := httptest.NewServer(github)
	t.Cleanup(githubServer.Close)
	return newConfiguredRelay(t, Config{
		WebhookSecret: "secret", GitHubAPIURL: githubServer.URL, HTTPClient: githubServer.Client(),
	})
}

func githubAccess(handler func(*http.Request) int) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/user" {
			response.Header().Set("Content-Type", "application/json")
			response.Write([]byte(`{"id":123,"login":"octocat"}`))
			return
		}
		response.WriteHeader(handler(request))
	})
}

func signedWebhookRequest(body []byte, event string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/github", bytes.NewReader(body))
	mac := hmac.New(sha256.New, []byte("secret"))
	mac.Write(body)
	request.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	request.Header.Set("X-GitHub-Event", event)
	return request
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

func postSession(t *testing.T, server *Server, token string) (int, string) {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/session", bytes.NewBufferString(`{"repos":["owner/repo"]}`))
	request.Header.Set("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	var payload struct {
		Ticket string `json:"ticket"`
	}
	if response.Code == http.StatusOK {
		if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
	}
	return response.Code, payload.Ticket
}

func TestUsageExistsOnlyOnAdminHandlerAndValidatesDays(t *testing.T) {
	server, _ := newTestRelay(t, githubAccess(func(*http.Request) int { return http.StatusOK }))
	publicResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(publicResponse, httptest.NewRequest(http.MethodGet, "/usage", nil))
	if publicResponse.Code != http.StatusNotFound {
		t.Fatalf("public /usage status = %d, want 404", publicResponse.Code)
	}
	for _, path := range []string{"/usage?days=0", "/usage?days=91", "/usage?days=invalid", "/usage?days="} {
		response := httptest.NewRecorder()
		server.AdminHandler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusBadRequest {
			t.Fatalf("%s status = %d, want 400", path, response.Code)
		}
	}
	response := httptest.NewRecorder()
	server.AdminHandler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/usage", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("admin /usage status = %d, want 200", response.Code)
	}
	var report UsageReport
	if err := json.Unmarshal(response.Body.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	if len(report.Days) != 7 {
		t.Fatalf("default days = %d, want 7", len(report.Days))
	}
}

func TestSessionRecordsOnlySuccessfulActivity(t *testing.T) {
	server, store := newTestRelay(t, githubAccess(func(request *http.Request) int {
		if request.Header.Get("Authorization") == "Bearer readable" {
			return http.StatusOK
		}
		return http.StatusNotFound
	}))
	if status, _ := postSession(t, server, "unreadable"); status != http.StatusForbidden {
		t.Fatalf("unreadable status = %d, want 403", status)
	}
	if status, _ := postSession(t, server, "readable"); status != http.StatusOK {
		t.Fatalf("readable status = %d, want 200", status)
	}
	report, err := store.Usage(context.Background(), 1, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if report.DAU != 1 || len(report.Days[0].Users) != 1 || report.Days[0].Users[0].Sessions != 1 {
		t.Fatalf("usage = %#v", report)
	}
}

func TestSessionsAcrossTokensRecordOneGitHubActor(t *testing.T) {
	server, store := newTestRelay(t, githubAccess(func(*http.Request) int { return http.StatusOK }))
	for _, token := range []string{"first-token", "second-token"} {
		status, _ := postSession(t, server, token)
		if status != http.StatusOK {
			t.Fatalf("%s status = %d, want 200", token, status)
		}
	}
	report, err := store.Usage(context.Background(), 1, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Days[0].Users) != 1 || report.Days[0].Users[0].Sessions != 2 {
		t.Fatalf("usage = %#v", report)
	}
}

func TestStreamLimitSpansTokensForSameGitHubUser(t *testing.T) {
	server, _ := newTestRelay(t, githubAccess(func(*http.Request) int { return http.StatusOK }))
	httpServer := httptest.NewServer(server.Handler())
	defer httpServer.Close()
	streamURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/stream?ticket="
	connections := make([]*websocket.Conn, 0, maxPrincipalStreams)
	defer func() {
		for _, connection := range connections {
			connection.Close()
		}
	}()
	for range maxPrincipalStreams {
		status, ticket := postSession(t, server, "first-token")
		if status != http.StatusOK {
			t.Fatalf("first-token session status = %d", status)
		}
		connection, _, err := websocket.DefaultDialer.Dial(streamURL+ticket, nil)
		if err != nil {
			t.Fatal(err)
		}
		connections = append(connections, connection)
		var ready readyFrame
		if err := connection.ReadJSON(&ready); err != nil {
			t.Fatal(err)
		}
	}

	status, ticket := postSession(t, server, "second-token")
	if status != http.StatusOK {
		t.Fatalf("second-token session status = %d", status)
	}
	rejected, response, err := websocket.DefaultDialer.Dial(streamURL+ticket, nil)
	if rejected != nil {
		rejected.Close()
	}
	if err == nil || response == nil || response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("same-user stream admission error = %v, response = %#v", err, response)
	}
	response.Body.Close()

	connections[0].WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))
	connections[0].Close()
	deadline := time.Now().Add(time.Second)
	for {
		server.publishMu.Lock()
		active := len(server.subscribers)
		server.publishMu.Unlock()
		if active == maxPrincipalStreams-1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("active streams = %d after close", active)
		}
		time.Sleep(time.Millisecond)
	}

	status, ticket = postSession(t, server, "second-token")
	if status != http.StatusOK {
		t.Fatalf("replacement session status = %d", status)
	}
	replacement, _, err := websocket.DefaultDialer.Dial(streamURL+ticket, nil)
	if err != nil {
		t.Fatalf("replacement stream was rejected: %v", err)
	}
	connections = append(connections, replacement)
	var ready readyFrame
	if err := replacement.ReadJSON(&ready); err != nil {
		t.Fatal(err)
	}
}

func TestActivityTransactionFailureDoesNotDenySession(t *testing.T) {
	server, store := newTestRelay(t, githubAccess(func(*http.Request) int { return http.StatusOK }))
	if _, err := store.db.Exec(`INSERT INTO installation_coverage(owner, all_repos) VALUES('owner', 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`DROP TABLE usage_repo_daily`); err != nil {
		t.Fatal(err)
	}
	if status, _ := postSession(t, server, "token"); status != http.StatusOK {
		t.Fatalf("status = %d, want 200 despite activity write failure", status)
	}
	var users, repos int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM usage_daily`).Scan(&users); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM usage_repos`).Scan(&repos); err != nil {
		t.Fatal(err)
	}
	if users != 0 || repos != 0 {
		t.Fatalf("partial activity persisted: users = %d, repos = %d", users, repos)
	}
}

func TestSuccessfulSessionTriggersUsageRetentionCleanup(t *testing.T) {
	server, store := newTestRelay(t, githubAccess(func(*http.Request) int { return http.StatusOK }))
	if err := store.RecordActivity(context.Background(), GitHubIdentity{ID: 999, Login: "old-user"}, nil, time.Now().UTC().AddDate(0, 0, -90)); err != nil {
		t.Fatal(err)
	}
	server.cleanupAfter.Store(0)
	if status, _ := postSession(t, server, "token"); status != http.StatusOK {
		t.Fatalf("status = %d, want 200", status)
	}
	var oldRows int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM usage_daily WHERE github_user_id = 999`).Scan(&oldRows); err != nil {
		t.Fatal(err)
	}
	if oldRows != 0 {
		t.Fatalf("old usage rows = %d, want 0", oldRows)
	}
}

func TestSessionRecordsOnlyReadableReposWithRelayCoverage(t *testing.T) {
	server, store := newTestRelay(t, githubAccess(func(request *http.Request) int {
		if request.URL.Path == "/repos/owner/unreadable" {
			return http.StatusNotFound
		}
		return http.StatusOK
	}))
	if _, err := store.db.Exec(`
INSERT INTO installation_coverage(owner, all_repos) VALUES('owner', 0);
INSERT INTO installation_repos(owner, repo) VALUES('owner', 'owner/known');
`); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/session", bytes.NewBufferString(
		`{"repos":[" owner/known ","owner/known","owner/unknown","owner/unreadable"]}`,
	))
	request.Header.Set("Authorization", "Bearer token")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	var sessionResponse struct {
		Ticket string          `json:"ticket"`
		Repos  map[string]bool `json:"repos"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &sessionResponse); err != nil {
		t.Fatal(err)
	}
	session, ok := server.tickets.Consume(sessionResponse.Ticket)
	if !ok {
		t.Fatal("session ticket was not issued")
	}
	if _, ok := session.repos["owner/unknown"]; !ok {
		t.Fatal("readable unknown repository missing from ticket")
	}
	if _, ok := session.repos["owner/known"]; !ok {
		t.Fatal("readable known repository missing from ticket")
	}
	if !sessionResponse.Repos["owner/known"] || sessionResponse.Repos["owner/unknown"] {
		t.Fatalf("coverage = %#v", sessionResponse.Repos)
	}
	if _, ok := session.repos["owner/unreadable"]; ok {
		t.Fatal("unreadable repository present in ticket")
	}
	var unknownAllTime, unknownDaily, knownDaily int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM usage_repos WHERE repo = 'owner/unknown'`).Scan(&unknownAllTime); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM usage_repo_daily WHERE repo = 'owner/unknown'`).Scan(&unknownDaily); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM usage_repo_daily WHERE repo = 'owner/known'`).Scan(&knownDaily); err != nil {
		t.Fatal(err)
	}
	if unknownAllTime != 0 || unknownDaily != 0 || knownDaily != 1 {
		t.Fatalf("repo rows: unknown all-time = %d, unknown daily = %d, known daily = %d", unknownAllTime, unknownDaily, knownDaily)
	}
	adminResponse := httptest.NewRecorder()
	server.AdminHandler().ServeHTTP(adminResponse, httptest.NewRequest(http.MethodGet, "/usage?days=2", nil))
	if adminResponse.Code != http.StatusOK {
		t.Fatalf("admin status = %d", adminResponse.Code)
	}
	var report UsageReport
	if err := json.Unmarshal(adminResponse.Body.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	if len(report.Repos) != 1 || report.Repos[0].Name != "owner/known" || report.Repos[0].Sessions != 1 {
		t.Fatalf("report = %#v", report)
	}
	var userRepos []UsageUserRepo
	for _, day := range report.Days {
		if len(day.Users) != 0 {
			userRepos = day.Users[0].Repos
			break
		}
	}
	if len(userRepos) != 1 || userRepos[0].Name != "owner/known" {
		t.Fatalf("user repos = %#v", userRepos)
	}
}

func TestForwardWebhookDisabledDoesNotUseHTTPClient(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("disabled forwarding used the HTTP client")
		return nil, nil
	})}
	server, store := newConfiguredRelay(t, Config{WebhookSecret: "secret", HTTPClient: client})
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, signedWebhookRequest([]byte(`{"repository":{"full_name":"owner/repo"}}`), "push"))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	latest, _, err := store.LatestBounds(context.Background())
	if err != nil || latest != 1 {
		t.Fatalf("latest = %d, error = %v", latest, err)
	}
}

func TestDisabledForwardingPreservesGitHubAccessRedirects(t *testing.T) {
	destination := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusOK)
	}))
	defer destination.Close()
	github := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Location", destination.URL)
		response.WriteHeader(http.StatusTemporaryRedirect)
	}))
	defer github.Close()
	client := github.Client()
	server, _ := newConfiguredRelay(t, Config{
		WebhookSecret: "secret", GitHubAPIURL: github.URL, HTTPClient: client,
	})
	readable, _, err := server.access.ReadableUntil(context.Background(), "token", "owner/repo")
	if err != nil || !readable {
		t.Fatalf("readable = %v, error = %v", readable, err)
	}
	if server.access.client != client || server.forwardClient != nil {
		t.Fatal("disabled forwarding changed the GitHub access client")
	}
}

func TestForwardWebhookPreservesBodyAndAllowsOnlyGitHubHeaders(t *testing.T) {
	type forwarded struct {
		body   []byte
		header http.Header
		method string
		path   string
	}
	received := make(chan forwarded, 1)
	target := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		received <- forwarded{body: body, header: request.Header.Clone(), method: request.Method, path: request.URL.Path}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer target.Close()
	server, _ := newConfiguredRelay(t, Config{
		WebhookSecret: "secret", ForwardWebhookURL: target.URL + "/hooks/github", HTTPClient: target.Client(),
	})
	body := []byte("{\n  \"repository\": {\"full_name\": \"owner/repo\"}\n}")
	request := signedWebhookRequest(body, "push")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-GitHub-Delivery", "delivery-id")
	request.Header.Set("Authorization", "Bearer secret-token")
	request.Header.Set("Cookie", "session=secret")
	request.Header.Set("X-Other", "private")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	forwardedRequest := <-received
	if forwardedRequest.method != http.MethodPost || forwardedRequest.path != "/hooks/github" || !bytes.Equal(forwardedRequest.body, body) {
		t.Fatalf("forwarded request = %#v", forwardedRequest)
	}
	for _, header := range []string{"Content-Type", "X-Hub-Signature-256", "X-GitHub-Event", "X-GitHub-Delivery"} {
		if forwardedRequest.header.Get(header) != request.Header.Get(header) {
			t.Fatalf("%s = %q, want %q", header, forwardedRequest.header.Get(header), request.Header.Get(header))
		}
	}
	for _, header := range []string{"Authorization", "Cookie", "X-Other"} {
		if value := forwardedRequest.header.Get(header); value != "" {
			t.Fatalf("%s was forwarded: %q", header, value)
		}
	}
}

func TestForwardWebhookCoversEverySuccessfulLocalBranch(t *testing.T) {
	events := make(chan string, 4)
	target := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		io.Copy(io.Discard, request.Body)
		events <- request.Header.Get("X-GitHub-Event")
		response.WriteHeader(http.StatusNoContent)
	}))
	defer target.Close()
	server, _ := newConfiguredRelay(t, Config{
		WebhookSecret: "secret", ForwardWebhookURL: target.URL, HTTPClient: target.Client(),
	})
	for _, testCase := range []struct {
		event string
		body  string
		want  int
	}{
		{event: "installation", body: `{"installation":{}}`, want: http.StatusOK},
		{event: "installation_repositories", body: `{"installation":{}}`, want: http.StatusOK},
		{event: "ping", body: `{}`, want: http.StatusAccepted},
		{event: "push", body: `{"repository":{"full_name":"owner/repo"}}`, want: http.StatusOK},
	} {
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, signedWebhookRequest([]byte(testCase.body), testCase.event))
		if response.Code != testCase.want {
			t.Fatalf("%s status = %d, want %d", testCase.event, response.Code, testCase.want)
		}
		if event := <-events; event != testCase.event {
			t.Fatalf("forwarded event = %q, want %q", event, testCase.event)
		}
	}
}

func TestInvalidOrLocallyFailedWebhookIsNotForwarded(t *testing.T) {
	forwarded := 0
	target := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		forwarded++
		response.WriteHeader(http.StatusNoContent)
	}))
	defer target.Close()
	server, store := newConfiguredRelay(t, Config{
		WebhookSecret: "secret", ForwardWebhookURL: target.URL, HTTPClient: target.Client(),
	})
	badSignature := httptest.NewRequest(http.MethodPost, "/github", strings.NewReader(`{}`))
	badSignature.Header.Set("X-Hub-Signature-256", "sha256=00")
	badSignature.Header.Set("X-GitHub-Event", "push")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, badSignature)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("bad signature status = %d", response.Code)
	}
	response = httptest.NewRecorder()
	server.Handler().ServeHTTP(response, signedWebhookRequest([]byte(`{`), "push"))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("bad JSON status = %d", response.Code)
	}
	if _, err := store.db.Exec(`DROP TABLE markers`); err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	server.Handler().ServeHTTP(response, signedWebhookRequest([]byte(`{"repository":{"full_name":"owner/repo"}}`), "push"))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("local failure status = %d", response.Code)
	}
	if forwarded != 0 {
		t.Fatalf("forwarded calls = %d, want 0", forwarded)
	}
}

func TestForwardWebhookHTTPFailureKeepsLocalSuccess(t *testing.T) {
	target := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusServiceUnavailable)
		response.Write(bytes.Repeat([]byte("x"), forwardResponseLimit+1))
	}))
	defer target.Close()
	server, store := newConfiguredRelay(t, Config{
		WebhookSecret: "secret", ForwardWebhookURL: target.URL, HTTPClient: target.Client(),
	})
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, signedWebhookRequest([]byte(`{"repository":{"full_name":"owner/repo"}}`), "push"))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	latest, _, err := store.LatestBounds(context.Background())
	if err != nil || latest != 1 {
		t.Fatalf("latest = %d, error = %v", latest, err)
	}
}

func TestForwardWebhookTransportFailureKeepsLocalSuccess(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("upstream unavailable")
	})}
	server, store := newConfiguredRelay(t, Config{
		WebhookSecret: "secret", ForwardWebhookURL: "https://example.com/hooks/github", HTTPClient: client,
	})
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, signedWebhookRequest([]byte(`{"repository":{"full_name":"owner/repo"}}`), "push"))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	latest, _, err := store.LatestBounds(context.Background())
	if err != nil || latest != 1 {
		t.Fatalf("latest = %d, error = %v", latest, err)
	}
}

func TestForwardWebhookDoesNotFollowRedirects(t *testing.T) {
	redirected := make(chan []byte, 1)
	secondTarget := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		redirected <- body
		response.WriteHeader(http.StatusNoContent)
	}))
	defer secondTarget.Close()
	firstTarget := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Location", secondTarget.URL)
		response.WriteHeader(http.StatusTemporaryRedirect)
	}))
	defer firstTarget.Close()
	server, store := newConfiguredRelay(t, Config{
		WebhookSecret: "secret", ForwardWebhookURL: firstTarget.URL, HTTPClient: firstTarget.Client(),
	})
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, signedWebhookRequest([]byte(`{"repository":{"full_name":"owner/repo"}}`), "push"))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	select {
	case body := <-redirected:
		t.Fatalf("redirect target received signed body %q", body)
	default:
	}
	latest, _, err := store.LatestBounds(context.Background())
	if err != nil || latest != 1 {
		t.Fatalf("latest = %d, error = %v", latest, err)
	}
}

func TestForwardWebhookURLValidation(t *testing.T) {
	store := newUsageStore(t)
	for _, raw := range []string{
		"http://example.com/hook",
		"/relative",
		"https:///hook",
		"https://user@example.com/hook",
		"https://example.com/hook?token=secret",
		"https://example.com/hook?",
		"https://example.com/hook#fragment",
		"https://example.com/hook#",
	} {
		if _, err := NewServer(store, Config{WebhookSecret: "secret", ForwardWebhookURL: raw}); err == nil {
			t.Fatalf("URL %q was accepted", raw)
		}
	}
	injected := &http.Client{}
	server, err := NewServer(store, Config{
		WebhookSecret: "secret", ForwardWebhookURL: "https://example.com/hooks/github", HTTPClient: injected,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Shutdown()
	if server.access.client != injected || server.forwardClient == injected || server.forwardClient.Timeout != 10*time.Second {
		t.Fatalf("access client changed or forwarding client was not cloned and bounded")
	}
}

func newCutoffRelay(t *testing.T, store *Store, target *httptest.Server, cutoff, now time.Time) *Server {
	t.Helper()
	config := Config{
		WebhookSecret: "secret", ForwardWebhookURL: target.URL, HTTPClient: target.Client(),
	}
	if !cutoff.IsZero() {
		config.ForwardRepoDiscoveryUntil = cutoff.Format(time.RFC3339)
	}
	server, err := NewServer(store, config)
	if err != nil {
		t.Fatal(err)
	}
	server.now = func() time.Time { return now }
	t.Cleanup(server.Shutdown)
	return server
}

func sendRepositoryWebhook(t *testing.T, server *Server, repo string) int {
	t.Helper()
	response := httptest.NewRecorder()
	body := []byte(`{"repository":{"full_name":"` + repo + `"}}`)
	server.Handler().ServeHTTP(response, signedWebhookRequest(body, "push"))
	return response.Code
}

func TestEmptyForwardRepoCutoffPreservesForwardAll(t *testing.T) {
	forwarded := make(chan struct{}, 1)
	target := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		forwarded <- struct{}{}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer target.Close()
	store := newUsageStore(t)
	server := newCutoffRelay(t, store, target, time.Time{}, time.Now())
	if status := sendRepositoryWebhook(t, server, "owner/new"); status != http.StatusOK {
		t.Fatalf("status = %d, want 200", status)
	}
	<-forwarded
	var remembered int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM legacy_forward_repos`).Scan(&remembered); err != nil {
		t.Fatal(err)
	}
	if remembered != 0 {
		t.Fatalf("remembered repositories = %d, want 0 without cutoff", remembered)
	}
}

func TestInvalidForwardRepoCutoffFailsStartup(t *testing.T) {
	store := newUsageStore(t)
	for _, cutoff := range []string{"tomorrow", "2026-09-01T12:00:00", "2026-09-01"} {
		if _, err := NewServer(store, Config{
			WebhookSecret: "secret", ForwardRepoDiscoveryUntil: cutoff,
		}); err == nil {
			t.Fatalf("cutoff %q was accepted", cutoff)
		}
	}
}

func TestRepoSeenBeforeCutoffPersistsAcrossRestart(t *testing.T) {
	forwarded := make(chan struct{}, 3)
	target := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		forwarded <- struct{}{}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer target.Close()
	store := newUsageStore(t)
	cutoff := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	before := newCutoffRelay(t, store, target, cutoff, cutoff.Add(-time.Nanosecond))
	if status := sendRepositoryWebhook(t, before, "owner/legacy"); status != http.StatusOK {
		t.Fatalf("before-cutoff status = %d", status)
	}
	<-forwarded
	before.Shutdown()

	after := newCutoffRelay(t, store, target, cutoff, cutoff.Add(time.Nanosecond))
	if status := sendRepositoryWebhook(t, after, "owner/legacy"); status != http.StatusOK {
		t.Fatalf("remembered status = %d", status)
	}
	<-forwarded
	if status := sendRepositoryWebhook(t, after, "owner/new"); status != http.StatusOK {
		t.Fatalf("new repository status = %d", status)
	}
	select {
	case <-forwarded:
		t.Fatal("new repository forwarded after cutoff")
	default:
	}
	remembered, err := store.IsLegacyForwardRepo(context.Background(), "owner/legacy")
	if err != nil || !remembered {
		t.Fatalf("remembered = %v, error = %v", remembered, err)
	}
}

func TestRepoFirstSeenAtOrAfterCutoffDoesNotForward(t *testing.T) {
	forwarded := make(chan struct{}, 2)
	target := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		forwarded <- struct{}{}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer target.Close()
	store := newUsageStore(t)
	cutoff := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	server := newCutoffRelay(t, store, target, cutoff, cutoff)
	if status := sendRepositoryWebhook(t, server, "owner/exact"); status != http.StatusOK {
		t.Fatalf("exact-cutoff status = %d", status)
	}
	server.now = func() time.Time { return cutoff.Add(time.Second) }
	if status := sendRepositoryWebhook(t, server, "owner/after"); status != http.StatusOK {
		t.Fatalf("after-cutoff status = %d", status)
	}
	select {
	case <-forwarded:
		t.Fatal("new repository forwarded at or after cutoff")
	default:
	}
	latest, _, err := store.LatestBounds(context.Background())
	if err != nil || latest != 2 {
		t.Fatalf("latest = %d, error = %v", latest, err)
	}
}

func TestNoRepoWebhookForwardsAfterCutoff(t *testing.T) {
	forwarded := make(chan struct{}, 1)
	target := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		forwarded <- struct{}{}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer target.Close()
	store := newUsageStore(t)
	cutoff := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	server := newCutoffRelay(t, store, target, cutoff, cutoff)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, signedWebhookRequest([]byte(`{}`), "ping"))
	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202", response.Code)
	}
	<-forwarded
}

func TestRepoEligibilityFailureIsBestEffort(t *testing.T) {
	forwarded := make(chan struct{}, 2)
	target := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		forwarded <- struct{}{}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer target.Close()
	store := newUsageStore(t)
	cutoff := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	server := newCutoffRelay(t, store, target, cutoff, cutoff.Add(-time.Second))
	if _, err := store.db.Exec(`DROP TABLE legacy_forward_repos`); err != nil {
		t.Fatal(err)
	}
	if status := sendRepositoryWebhook(t, server, "owner/before"); status != http.StatusOK {
		t.Fatalf("insert-failure status = %d", status)
	}
	<-forwarded
	server.now = func() time.Time { return cutoff }
	if status := sendRepositoryWebhook(t, server, "owner/after"); status != http.StatusOK {
		t.Fatalf("lookup-failure status = %d", status)
	}
	select {
	case <-forwarded:
		t.Fatal("repository forwarded after eligibility lookup failure")
	default:
	}
	latest, _, err := store.LatestBounds(context.Background())
	if err != nil || latest != 2 {
		t.Fatalf("latest = %d, error = %v", latest, err)
	}
}

func TestForwardCutoffUsesWebhookReceivedTime(t *testing.T) {
	forwarded := make(chan struct{}, 1)
	target := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		forwarded <- struct{}{}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer target.Close()
	store := newUsageStore(t)
	cutoff := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	server := newCutoffRelay(t, store, target, cutoff, cutoff)
	nowCalls := 0
	server.now = func() time.Time {
		nowCalls++
		if nowCalls == 1 {
			return cutoff.Add(-time.Nanosecond)
		}
		return cutoff
	}
	if status := sendRepositoryWebhook(t, server, "owner/crossing"); status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	<-forwarded
	if nowCalls != 1 {
		t.Fatalf("clock reads = %d, want 1", nowCalls)
	}
	remembered, err := store.IsLegacyForwardRepo(context.Background(), "owner/crossing")
	if err != nil || !remembered {
		t.Fatalf("remembered = %v, error = %v", remembered, err)
	}
}

func TestDisabledPreCutoffDiscoveryForwardsAfterRestart(t *testing.T) {
	store := newUsageStore(t)
	cutoff := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	before, err := NewServer(store, Config{
		WebhookSecret: "secret", ForwardRepoDiscoveryUntil: cutoff.Format(time.RFC3339),
	})
	if err != nil {
		t.Fatal(err)
	}
	before.now = func() time.Time { return cutoff.Add(-time.Second) }
	if status := sendRepositoryWebhook(t, before, "owner/discovered-disabled"); status != http.StatusOK {
		t.Fatalf("disabled status = %d", status)
	}
	before.Shutdown()

	forwarded := make(chan struct{}, 1)
	target := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		forwarded <- struct{}{}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer target.Close()
	after := newCutoffRelay(t, store, target, cutoff, cutoff)
	if status := sendRepositoryWebhook(t, after, "owner/discovered-disabled"); status != http.StatusOK {
		t.Fatalf("enabled status = %d", status)
	}
	<-forwarded
}
