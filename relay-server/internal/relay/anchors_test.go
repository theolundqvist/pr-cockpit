package relay

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

const testRepoID = 42

type testClock struct{ ms atomic.Int64 }

func (c *testClock) now() time.Time   { return time.UnixMilli(c.ms.Load()) }
func (c *testClock) set(at time.Time) { c.ms.Store(at.UnixMilli()) }

func sha(seed string) string { return strings.Repeat(seed, 40)[:40] }

// specAnchorID and specProof restate the wire formulas independently of the implementation.
func specAnchorID(repo string, repoID int64, after string) string {
	digest := sha256.Sum256([]byte(fmt.Sprintf("pr-cockpit-relay anchor\n%s\n%d\n%s", repo, repoID, after)))
	return hex.EncodeToString(digest[:])
}

func specProof(repo string, repoID int64, after, tree string) string {
	digest := sha256.Sum256([]byte(fmt.Sprintf("pr-cockpit-relay proof\n%s\n%d\n%s\n%s", repo, repoID, after, tree)))
	return hex.EncodeToString(digest[:])
}

func newAnchorRelay(t *testing.T) (*Server, *Store, *testClock) {
	t.Helper()
	server, store := newTestRelay(t, http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		t.Errorf("anchor flow called GitHub: %s", request.URL.Path)
	}))
	clock := &testClock{}
	clock.set(time.Now())
	server.now = clock.now
	return server, store, clock
}

func pushEvent(repo string, repoID int64, after, tree string, pushedAt time.Time) map[string]any {
	return map[string]any{
		"ref": "refs/heads/main", "after": after, "deleted": false,
		"head_commit": map[string]any{"id": after, "tree_id": tree},
		"repository":  map[string]any{"id": repoID, "full_name": repo, "default_branch": "main", "pushed_at": pushedAt.Unix()},
	}
}

func deliver(t *testing.T, server *Server, event string, payload any) {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, signedWebhookRequest(body, event))
	if response.Code != http.StatusOK {
		t.Fatalf("%s webhook status = %d: %s", event, response.Code, response.Body)
	}
}

func pushAnchor(t *testing.T, server *Server, clock *testClock, repo, after, tree string) {
	t.Helper()
	deliver(t, server, "push", pushEvent(repo, testRepoID, after, tree, clock.now()))
}

func postJSON(t *testing.T, server *Server, path string, payload any, header http.Header) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	for name, values := range header {
		request.Header[name] = values
	}
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	return response
}

func lookupAnchors(t *testing.T, server *Server, repos map[string][]string) map[string]*string {
	t.Helper()
	response := postJSON(t, server, "/anchors", map[string]any{"repos": repos}, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("/anchors status = %d: %s", response.Code, response.Body)
	}
	var payload struct {
		Repos map[string]*string `json:"repos"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	return payload.Repos
}

type proofSessionResponse struct {
	status    int
	Ticket    string          `json:"ticket"`
	ExpiresAt int64           `json:"expiresAt"`
	Repos     map[string]bool `json:"repos"`
}

func openProofSession(t *testing.T, server *Server, body map[string]any) proofSessionResponse {
	t.Helper()
	response := postJSON(t, server, "/session", body, nil)
	result := proofSessionResponse{status: response.Code}
	if response.Code == http.StatusOK {
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
	}
	return result
}

func dialStream(t *testing.T, httpServer *httptest.Server, ticket string) *websocket.Conn {
	t.Helper()
	connection, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(httpServer.URL, "http")+"/stream?ticket="+ticket, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { connection.Close() })
	var ready readyFrame
	if err := connection.ReadJSON(&ready); err != nil || ready.Type != "ready" {
		t.Fatalf("ready = %#v, err = %v", ready, err)
	}
	return connection
}

type streamFrame struct {
	Type   string `json:"type"`
	Repo   string `json:"repo"`
	Marker Marker `json:"marker"`
}

func readFrame(t *testing.T, connection *websocket.Conn) streamFrame {
	t.Helper()
	connection.SetReadDeadline(time.Now().Add(2 * time.Second))
	var frame streamFrame
	if err := connection.ReadJSON(&frame); err != nil {
		t.Fatal(err)
	}
	return frame
}

func pullRequestEvent(repo string) map[string]any {
	return map[string]any{"repository": map[string]any{"full_name": repo}, "pull_request": map[string]any{"number": 1}}
}

// The client implementation asserts the same vector.
func TestAnchorHashesMatchSharedVector(t *testing.T) {
	const (
		wantID    = "3d248f6cb2f988aa39149cce10010a3c6b1fb83ce29332490104b3ea95cc1b01"
		wantProof = "e1acac39635db6c6e8bda37aaea97b6ab30916391393d0524ff73c6a413074c1"
	)
	server, _, clock := newAnchorRelay(t)
	pushAnchor(t, server, clock, "Acme/App", sha("a"), sha("b"))
	if matched := lookupAnchors(t, server, map[string][]string{"Acme/App": {wantID}})["Acme/App"]; matched == nil || *matched != wantID {
		t.Fatalf("anchor id match = %v, want %s", matched, wantID)
	}
	if session := openProofSession(t, server, map[string]any{"proofs": map[string]string{"Acme/App": wantProof}}); session.status != http.StatusOK || !session.Repos["Acme/App"] {
		t.Fatalf("vector proof session = %#v", session)
	}
}

func TestCapabilitiesAdvertiseAnchors(t *testing.T) {
	server, _, _ := newAnchorRelay(t)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/capabilities", nil))
	if body := strings.TrimSpace(response.Body.String()); body != `{"anchors":"v1","stream":"websocket-v1"}` {
		t.Fatalf("capabilities = %s", body)
	}
}

func TestDefaultBranchPushAnchorsProofSessionStream(t *testing.T) {
	server, store, clock := newAnchorRelay(t)
	after, tree := sha("a"), sha("b")
	pushAnchor(t, server, clock, "Owner/Repo", after, tree)

	id := specAnchorID("owner/repo", testRepoID, after)
	if matched := lookupAnchors(t, server, map[string][]string{"Owner/Repo": {sha("0") + sha("0")[:24], id}})["Owner/Repo"]; matched == nil || *matched != id {
		t.Fatalf("anchor match = %v, want %s", matched, id)
	}
	session := openProofSession(t, server, map[string]any{
		"proofs":  map[string]string{"Owner/Repo": specProof("owner/repo", testRepoID, after, tree)},
		"user":    map[string]any{"id": 7, "login": "octo"},
		"install": "install-1",
	})
	if session.status != http.StatusOK || !session.Repos["Owner/Repo"] {
		t.Fatalf("session = %#v", session)
	}
	if want := clock.now().Add(24 * time.Hour).UnixMilli(); session.ExpiresAt != want {
		t.Fatalf("expiresAt = %d, want %d", session.ExpiresAt, want)
	}

	httpServer := httptest.NewServer(server.Handler())
	defer httpServer.Close()
	connection := dialStream(t, httpServer, session.Ticket)
	deliver(t, server, "pull_request", pullRequestEvent("owner/other"))
	deliver(t, server, "pull_request", pullRequestEvent("owner/repo"))
	if frame := readFrame(t, connection); frame.Type != "marker" || frame.Marker.Repo != "owner/repo" {
		t.Fatalf("frame = %#v, want only the proved repository's marker", frame)
	}

	report, err := store.Usage(context.Background(), 1, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Days[0].Users) != 1 || report.Days[0].Users[0].ID != 7 || report.Days[0].Users[0].Login != "octo" {
		t.Fatalf("usage = %#v", report.Days[0].Users)
	}
}

func TestPushesThatCannotAnchorAreIgnored(t *testing.T) {
	after, tree := sha("a"), sha("b")
	for name, mutate := range map[string]func(map[string]any){
		"non-default branch": func(push map[string]any) { push["ref"] = "refs/heads/feature" },
		"branch deletion":    func(push map[string]any) { push["deleted"] = true },
		"no head commit":     func(push map[string]any) { push["head_commit"] = nil },
		"head is not after":  func(push map[string]any) { push["head_commit"] = map[string]any{"id": sha("c"), "tree_id": tree} },
		"uppercase tree": func(push map[string]any) {
			push["head_commit"] = map[string]any{"id": after, "tree_id": strings.ToUpper(sha("e"))}
		},
		"redelivered old push": func(push map[string]any) {
			push["repository"].(map[string]any)["pushed_at"] = time.Now().Add(-11 * time.Minute).Unix()
		},
		"missing repository id": func(push map[string]any) { delete(push["repository"].(map[string]any), "id") },
	} {
		t.Run(name, func(t *testing.T) {
			server, store, clock := newAnchorRelay(t)
			push := pushEvent("owner/repo", testRepoID, after, tree, clock.now())
			mutate(push)
			deliver(t, server, "push", push)
			if matched := lookupAnchors(t, server, map[string][]string{"owner/repo": {specAnchorID("owner/repo", testRepoID, after)}})["owner/repo"]; matched != nil {
				t.Fatalf("ignored push created anchor %s", *matched)
			}
			if latest, _, err := store.LatestBounds(context.Background()); err != nil || latest != 1 {
				t.Fatalf("push marker latest = %d, err = %v", latest, err)
			}
		})
	}
}

func TestAnchorsReturnIndistinguishableNulls(t *testing.T) {
	server, _, clock := newAnchorRelay(t)
	after := sha("a")
	pushAnchor(t, server, clock, "owner/repo", after, sha("b"))
	response := postJSON(t, server, "/anchors", map[string]any{"repos": map[string][]string{
		"owner/repo":    {specAnchorID("owner/repo", testRepoID+1, after), sha("f") + sha("f")[:24]},
		"owner/missing": {specAnchorID("owner/missing", testRepoID, after)},
		"owner/empty":   {},
	}}, nil)
	if body := strings.TrimSpace(response.Body.String()); body != `{"repos":{"owner/empty":null,"owner/missing":null,"owner/repo":null}}` {
		t.Fatalf("anchors = %s", body)
	}

	tooManyRepos := make(map[string][]string, maxAnchorRepos+1)
	for index := range maxAnchorRepos + 1 {
		tooManyRepos[fmt.Sprintf("owner/repo-%d", index)] = nil
	}
	for name, body := range map[string]any{
		"too many repos": map[string]any{"repos": tooManyRepos},
		"too many ids":   map[string]any{"repos": map[string][]string{"owner/repo": make([]string, maxAnchorIDs+1)}},
		"unknown field":  map[string]any{"repos": map[string][]string{"owner/repo": {}}, "token": "x"},
		"invalid repo":   map[string]any{"repos": map[string][]string{"owner": {}}},
	} {
		if response := postJSON(t, server, "/anchors", body, nil); response.Code != http.StatusBadRequest {
			t.Fatalf("%s status = %d, want 400", name, response.Code)
		}
	}
}

func TestProofSessionValidatesEachRepository(t *testing.T) {
	server, store, clock := newAnchorRelay(t)
	pushAnchor(t, server, clock, "owner/one", sha("1"), sha("2"))
	pushAnchor(t, server, clock, "owner/two", sha("3"), sha("4"))
	validOne := specProof("owner/one", testRepoID, sha("1"), sha("2"))
	// The commit SHA alone must not suffice: a proof over a guessed tree is rejected.
	guessedTwo := specProof("owner/two", testRepoID, sha("3"), sha("3"))

	session := openProofSession(t, server, map[string]any{
		"proofs": map[string]string{"owner/one": validOne, "owner/two": guessedTwo, "owner/none": validOne},
		"user":   map[string]any{"id": 0, "login": "anonymous"},
	})
	if session.status != http.StatusOK || !session.Repos["owner/one"] || session.Repos["owner/two"] || session.Repos["owner/none"] || len(session.Repos) != 3 {
		t.Fatalf("session = %#v", session)
	}
	ticket, ok := server.tickets.Consume(session.Ticket)
	if !ok || len(ticket.repos) != 1 || ticket.repos["owner/one"].proof != validOne {
		t.Fatalf("ticket = %#v", ticket)
	}
	digest := sha256.Sum256([]byte(validOne))
	if ticket.principal != "anchors:"+hex.EncodeToString(digest[:]) {
		t.Fatalf("principal = %q", ticket.principal)
	}
	if report, err := store.Usage(context.Background(), 1, time.Now()); err != nil || report.DAU != 0 {
		t.Fatalf("usage without a user id = %#v, err = %v", report, err)
	}

	install := openProofSession(t, server, map[string]any{"proofs": map[string]string{"owner/one": validOne}, "install": "install-1"})
	if ticket, ok := server.tickets.Consume(install.Ticket); !ok || ticket.principal != "install:install-1" {
		t.Fatalf("install principal = %#v", ticket)
	}
	if denied := openProofSession(t, server, map[string]any{"proofs": map[string]string{"owner/two": guessedTwo, "owner/none": validOne}}); denied.status != http.StatusForbidden {
		t.Fatalf("all-invalid status = %d, want 403", denied.status)
	}
	bearer := http.Header{"Authorization": {"Bearer token"}}
	if response := postJSON(t, server, "/session", map[string]any{"proofs": map[string]string{"owner/one": validOne}}, bearer); response.Code != http.StatusBadRequest {
		t.Fatalf("proof session with bearer status = %d, want 400", response.Code)
	}
	if response := postJSON(t, server, "/session", map[string]any{"repos": []string{"owner/one"}}, nil); response.Code != http.StatusUnauthorized {
		t.Fatalf("repository session without bearer status = %d, want 401", response.Code)
	}
}

func TestAnchorRotationGraceAndEnforcedRevocation(t *testing.T) {
	server, store := newTestRelay(t, githubAccess(func(*http.Request) int { return http.StatusOK }))
	clock := &testClock{}
	server.now = clock.now
	rotateAt := time.Now()
	clock.set(rotateAt.Add(-24 * time.Hour))
	pushAnchor(t, server, clock, "owner/repo", sha("a"), sha("b"))
	clock.set(rotateAt.Add(-time.Hour))
	pushAnchor(t, server, clock, "owner/repo", sha("c"), sha("d"))
	pushAnchor(t, server, clock, "owner/other", sha("e"), sha("f"))
	oldID := specAnchorID("owner/repo", testRepoID, sha("a"))
	if matched := lookupAnchors(t, server, map[string][]string{"owner/repo": {oldID, specAnchorID("owner/repo", testRepoID, sha("c"))}})["owner/repo"]; matched == nil || *matched != oldID {
		t.Fatalf("push before 24h replaced the anchor: %v", matched)
	}

	oldProof := specProof("owner/repo", testRepoID, sha("a"), sha("b"))
	proofs := map[string]any{"proofs": map[string]string{"owner/repo": oldProof, "owner/other": specProof("owner/other", testRepoID, sha("e"), sha("f"))}, "install": "live"}
	live := openProofSession(t, server, proofs)
	pending := openProofSession(t, server, map[string]any{"proofs": map[string]string{"owner/repo": oldProof}})
	if live.status != http.StatusOK || pending.status != http.StatusOK {
		t.Fatalf("pre-rotation sessions = %d, %d", live.status, pending.status)
	}
	httpServer := httptest.NewServer(server.Handler())
	defer httpServer.Close()
	anchorStream := dialStream(t, httpServer, live.Ticket)
	status, tokenTicket := postSession(t, server, "token")
	if status != http.StatusOK {
		t.Fatalf("token session status = %d", status)
	}
	tokenStream := dialStream(t, httpServer, tokenTicket)

	clock.set(rotateAt)
	newAfter, newTree := sha("1"), sha("2")
	pushAnchor(t, server, clock, "owner/repo", newAfter, newTree)
	prevUntil := rotateAt.Add(time.Hour)
	// Rotate frames and markers travel on separate queues, so only their set is ordered.
	seen := map[string]bool{}
	for range 2 {
		frame := readFrame(t, anchorStream)
		seen[frame.Type+":"+frame.Repo+frame.Marker.Event] = true
	}
	if !seen["rotate:owner/repo"] || !seen["marker:push"] {
		t.Fatalf("anchor frames = %v, want the rotating push marker and a rotate frame", seen)
	}
	deliver(t, server, "pull_request", pullRequestEvent("owner/repo"))
	if frame := readFrame(t, anchorStream); frame.Type != "marker" || frame.Marker.Event != "pull_request" {
		t.Fatalf("grace marker = %#v", frame)
	}
	for _, event := range []string{"push", "pull_request"} {
		if frame := readFrame(t, tokenStream); frame.Type != "marker" || frame.Marker.Event != event {
			t.Fatalf("token stream frame = %#v, want %s marker and no rotate", frame, event)
		}
	}
	ticket, ok := server.tickets.Consume(pending.Ticket)
	if !ok || !ticket.repos["owner/repo"].expires.Equal(time.UnixMilli(prevUntil.UnixMilli())) {
		t.Fatalf("unconsumed ticket grant = %#v, want capped at %v", ticket.repos, prevUntil)
	}

	clock.set(rotateAt.Add(30 * time.Minute))
	grace := openProofSession(t, server, map[string]any{"proofs": map[string]string{"owner/repo": oldProof}})
	if grace.status != http.StatusOK || grace.ExpiresAt != prevUntil.UnixMilli() {
		t.Fatalf("grace session = %#v, want expiry %d", grace, prevUntil.UnixMilli())
	}
	current := openProofSession(t, server, map[string]any{"proofs": map[string]string{"owner/repo": specProof("owner/repo", testRepoID, newAfter, newTree)}})
	if current.status != http.StatusOK || current.ExpiresAt != clock.now().Add(24*time.Hour).UnixMilli() {
		t.Fatalf("current session = %#v", current)
	}
	if matched := lookupAnchors(t, server, map[string][]string{"owner/repo": {oldID}})["owner/repo"]; matched == nil || *matched != oldID {
		t.Fatalf("previous anchor id during grace = %v", matched)
	}

	clock.set(prevUntil.Add(time.Second))
	if expired := openProofSession(t, server, map[string]any{"proofs": map[string]string{"owner/repo": oldProof}}); expired.status != http.StatusForbidden {
		t.Fatalf("previous proof after grace status = %d, want 403", expired.status)
	}
	if matched := lookupAnchors(t, server, map[string][]string{"owner/repo": {oldID}})["owner/repo"]; matched != nil {
		t.Fatalf("previous anchor id after grace = %s", *matched)
	}
	deliver(t, server, "pull_request", pullRequestEvent("owner/repo"))
	deliver(t, server, "pull_request", pullRequestEvent("owner/other"))
	if frame := readFrame(t, anchorStream); frame.Type != "marker" || frame.Marker.Repo != "owner/other" {
		t.Fatalf("frame after grace = %#v, want the revoked repository skipped", frame)
	}
	var pushes int
	if err := store.db.QueryRow(`SELECT pushes_since FROM relay_anchors WHERE repo = 'owner/repo'`).Scan(&pushes); err != nil || pushes != 0 {
		t.Fatalf("pushes_since after rotation = %d, err = %v", pushes, err)
	}
}

func TestRepositoryIDChangeReplacesAnchorWithoutGrace(t *testing.T) {
	server, _, clock := newAnchorRelay(t)
	pushAnchor(t, server, clock, "owner/repo", sha("a"), sha("b"))
	oldProof := specProof("owner/repo", testRepoID, sha("a"), sha("b"))
	live := openProofSession(t, server, map[string]any{"proofs": map[string]string{"owner/repo": oldProof}})
	httpServer := httptest.NewServer(server.Handler())
	defer httpServer.Close()
	stream := dialStream(t, httpServer, live.Ticket)

	clock.set(clock.now().Add(time.Minute))
	deliver(t, server, "push", pushEvent("owner/repo", testRepoID+1, sha("c"), sha("d"), clock.now()))
	if frame := readFrame(t, stream); frame.Type != "rotate" {
		t.Fatalf("frame = %#v, want rotate", frame)
	}
	stream.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	if _, message, err := stream.ReadMessage(); err == nil {
		t.Fatalf("recreated repository's marker reached the old reader: %s", message)
	}
	if denied := openProofSession(t, server, map[string]any{"proofs": map[string]string{"owner/repo": oldProof}}); denied.status != http.StatusForbidden {
		t.Fatalf("old repository proof status = %d, want 403", denied.status)
	}
	newID := specAnchorID("owner/repo", testRepoID+1, sha("c"))
	if matched := lookupAnchors(t, server, map[string][]string{"owner/repo": {specAnchorID("owner/repo", testRepoID, sha("a")), newID}})["owner/repo"]; matched == nil || *matched != newID {
		t.Fatalf("replacement anchor = %v", matched)
	}
}

func TestAnchorRotatesAfterEightyPushes(t *testing.T) {
	store := newUsageStore(t)
	ctx := context.Background()
	now := time.Now()
	if _, _, err := store.CaptureAnchor(ctx, "owner/repo", testRepoID, sha("a"), sha("b"), now); err != nil {
		t.Fatal(err)
	}
	for index := range anchorRotationPushes {
		after := fmt.Sprintf("%040x", index+1)
		if _, changed, err := store.CaptureAnchor(ctx, "owner/repo", testRepoID, after, after, now); err != nil || changed {
			t.Fatalf("push %d changed = %v, err = %v", index+1, changed, err)
		}
	}
	change, changed, err := store.CaptureAnchor(ctx, "owner/repo", testRepoID, sha("c"), sha("d"), now)
	if err != nil || !changed || change.prevProof != specProof("owner/repo", testRepoID, sha("a"), sha("b")) || change.proof != specProof("owner/repo", testRepoID, sha("c"), sha("d")) {
		t.Fatalf("push 81 change = %#v, changed = %v, err = %v", change, changed, err)
	}
}

func TestConcurrentDeliveriesRotateOnce(t *testing.T) {
	store := newUsageStore(t)
	ctx := context.Background()
	setAt := time.Now().Add(-25 * time.Hour)
	if _, _, err := store.CaptureAnchor(ctx, "owner/repo", testRepoID, sha("a"), sha("b"), setAt); err != nil {
		t.Fatal(err)
	}
	var rotations atomic.Int32
	var wait sync.WaitGroup
	for index := range 16 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			after := fmt.Sprintf("%040x", index+1)
			_, changed, err := store.CaptureAnchor(ctx, "owner/repo", testRepoID, after, after, time.Now())
			if err != nil {
				t.Error(err)
			}
			if changed {
				rotations.Add(1)
			}
		}()
	}
	wait.Wait()
	anchors, err := store.Anchors(ctx, []string{"owner/repo"})
	if err != nil {
		t.Fatal(err)
	}
	if rotations.Load() != 1 || anchors["owner/repo"].prevProof != specProof("owner/repo", testRepoID, sha("a"), sha("b")) {
		t.Fatalf("rotations = %d, anchor = %#v", rotations.Load(), anchors["owner/repo"])
	}
}

func TestInstallationRemovalDeletesAnchors(t *testing.T) {
	server, _, clock := newAnchorRelay(t)
	for _, repo := range []string{"owner/one", "owner/two", "other/three"} {
		pushAnchor(t, server, clock, repo, sha("a"), sha("b"))
	}
	pending := openProofSession(t, server, map[string]any{"proofs": map[string]string{"owner/one": specProof("owner/one", testRepoID, sha("a"), sha("b"))}})
	ids := func() map[string][]string {
		return map[string][]string{
			"owner/one":   {specAnchorID("owner/one", testRepoID, sha("a"))},
			"owner/two":   {specAnchorID("owner/two", testRepoID, sha("a"))},
			"other/three": {specAnchorID("other/three", testRepoID, sha("a"))},
		}
	}
	installation := map[string]any{"repository_selection": "selected", "account": map[string]any{"login": "Owner"}}
	deliver(t, server, "installation_repositories", map[string]any{
		"action": "removed", "installation": installation, "repositories_removed": []map[string]any{{"full_name": "Owner/One"}},
	})
	if matched := lookupAnchors(t, server, ids()); matched["owner/one"] != nil || matched["owner/two"] == nil || matched["other/three"] == nil {
		t.Fatalf("after repository removal = %#v", matched)
	}
	if ticket, ok := server.tickets.Consume(pending.Ticket); !ok || ticket.repos["owner/one"].expires.After(clock.now()) {
		t.Fatalf("removed repository grant = %#v", ticket.repos)
	}
	deliver(t, server, "installation", map[string]any{"action": "deleted", "installation": installation})
	if matched := lookupAnchors(t, server, ids()); matched["owner/two"] != nil || matched["other/three"] == nil {
		t.Fatalf("after installation deletion = %#v", matched)
	}
}
