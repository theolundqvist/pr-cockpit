package relay

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

const (
	subscriberBuffer     = 256
	cleanupInterval      = time.Minute
	maxReplayBacklog     = 10_000
	bodyReaderLimit      = 64
	maxSubscribers       = 1024
	maxPrincipalStreams  = 4
	forwardResponseLimit = 64 << 10
)

type Config struct {
	WebhookSecret             string
	GitHubAPIURL              string
	ForwardWebhookURL         string
	ForwardRepoDiscoveryUntil string
	HTTPClient                *http.Client
	Logger                    *slog.Logger
}

var errSubscriberCapacity = errors.New("subscriber capacity reached")

type subscriber struct {
	principal   string
	repos       map[string]struct{}
	authExpires time.Time
	queue       chan Marker
	done        chan struct{}
	once        sync.Once
}

func (s *subscriber) stop() { s.once.Do(func() { close(s.done) }) }

type Server struct {
	store                     *Store
	secret                    []byte
	access                    *AccessChecker
	forwardClient             *http.Client
	forwardWebhookURL         string
	forwardRepoDiscoveryUntil time.Time
	now                       func() time.Time
	tickets                   *Tickets
	logger                    *slog.Logger
	publishMu                 sync.Mutex
	cleanupAfter              atomic.Int64
	subscribers               map[*subscriber]struct{}
	principalStreams          map[string]int
	bodySlots                 chan struct{}
	upgrader                  websocket.Upgrader
}

func NewServer(store *Store, config Config) (*Server, error) {
	if store == nil {
		return nil, errors.New("store is required")
	}
	if config.WebhookSecret == "" {
		return nil, errors.New("webhook secret is required")
	}
	if config.GitHubAPIURL == "" {
		config.GitHubAPIURL = "https://api.github.com"
	}
	if err := validateForwardWebhookURL(config.ForwardWebhookURL); err != nil {
		return nil, err
	}
	var forwardRepoDiscoveryUntil time.Time
	if config.ForwardRepoDiscoveryUntil != "" {
		var err error
		forwardRepoDiscoveryUntil, err = time.Parse(time.RFC3339, config.ForwardRepoDiscoveryUntil)
		if err != nil {
			return nil, errors.New("forward repository discovery cutoff must be RFC3339")
		}
	}
	if config.Logger == nil {
		config.Logger = slog.Default()
	}
	var forwardClient *http.Client
	if config.ForwardWebhookURL != "" {
		forwardClient = newForwardHTTPClient(config.HTTPClient)
	}
	server := &Server{
		store: store, secret: []byte(config.WebhookSecret),
		access:                    NewAccessChecker(config.HTTPClient, config.GitHubAPIURL),
		forwardClient:             forwardClient,
		forwardWebhookURL:         config.ForwardWebhookURL,
		forwardRepoDiscoveryUntil: forwardRepoDiscoveryUntil,
		now:                       time.Now,
		tickets:                   NewTickets(), logger: config.Logger,
		subscribers:      make(map[*subscriber]struct{}),
		principalStreams: make(map[string]int), bodySlots: make(chan struct{}, bodyReaderLimit),
		upgrader: websocket.Upgrader{HandshakeTimeout: 10 * time.Second, CheckOrigin: func(*http.Request) bool { return true }},
	}
	server.cleanupAfter.Store(time.Now().Add(cleanupInterval).UnixNano())
	return server, nil
}

func newForwardHTTPClient(client *http.Client) *http.Client {
	if client == nil {
		client = &http.Client{}
	}
	forwardClient := *client
	forwardClient.Jar = nil
	forwardClient.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	if forwardClient.Timeout <= 0 || forwardClient.Timeout > 10*time.Second {
		forwardClient.Timeout = 10 * time.Second
	}
	return &forwardClient
}

func validateForwardWebhookURL(raw string) error {
	if raw == "" {
		return nil
	}
	parsed, err := url.Parse(raw)
	if err != nil || !parsed.IsAbs() || parsed.Scheme != "https" || parsed.Host == "" ||
		parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || strings.Contains(raw, "#") {
		return errors.New("forward webhook URL must be an absolute HTTPS URL without userinfo, query, or fragment")
	}
	return nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("GET /capabilities", s.handleCapabilities)
	mux.HandleFunc("POST /github", s.handleGitHub)
	mux.HandleFunc("GET /events", s.handleEvents)
	mux.HandleFunc("GET /coverage", s.handleCoverage)
	mux.HandleFunc("POST /session", s.handleSession)
	mux.HandleFunc("GET /stream", s.handleStream)
	return mux
}

func (s *Server) AdminHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /usage", s.handleUsage)
	return mux
}

func (s *Server) handleUsage(response http.ResponseWriter, request *http.Request) {
	days := 7
	if request.URL.Query().Has("days") {
		var err error
		days, err = strconv.Atoi(request.URL.Query().Get("days"))
		if err != nil || days < 1 || days > 90 {
			http.Error(response, "days must be between 1 and 90", http.StatusBadRequest)
			return
		}
	}
	report, err := s.store.Usage(request.Context(), days, time.Now())
	if err != nil {
		s.internalError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, report)
}

func (s *Server) acquireBodyReader(response http.ResponseWriter) (func(), bool) {
	select {
	case s.bodySlots <- struct{}{}:
		return func() { <-s.bodySlots }, true
	default:
		http.Error(response, "request body capacity reached", http.StatusServiceUnavailable)
		return nil, false
	}
}

func (s *Server) handleHealth(response http.ResponseWriter, _ *http.Request) {
	response.Header().Set("Content-Type", "text/plain; charset=utf-8")
	response.Write([]byte("ok"))
}

func (s *Server) handleCapabilities(response http.ResponseWriter, _ *http.Request) {
	writeJSON(response, http.StatusOK, map[string]string{"stream": "websocket-v1"})
}

func (s *Server) handleGitHub(response http.ResponseWriter, request *http.Request) {
	release, ok := s.acquireBodyReader(response)
	if !ok {
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(response, request.Body, 10<<20))
	release()
	if err != nil {
		http.Error(response, "invalid body", http.StatusBadRequest)
		return
	}
	if !validSignature(s.secret, body, request.Header.Get("X-Hub-Signature-256")) {
		http.Error(response, "bad signature", http.StatusUnauthorized)
		return
	}
	var payload webhookPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		http.Error(response, "invalid JSON", http.StatusBadRequest)
		return
	}
	receivedAt := s.now()

	event := request.Header.Get("X-GitHub-Event")
	if event == "" {
		event = "unknown"
	}
	status := http.StatusOK
	message := "ok"
	forward := true
	if event == "installation" || event == "installation_repositories" {
		if err := s.store.UpdateInstallation(request.Context(), event, payload); err != nil {
			s.internalError(response, err)
			return
		}
	} else if payload.Repository == nil || payload.Repository.FullName == "" {
		status = http.StatusAccepted
		message = "no repository"
	} else {
		run, job := compactActions(event, payload)
		marker := Marker{TS: receivedAt.UnixMilli(), Repo: payload.Repository.FullName, Number: pullNumber(payload), Event: event, Run: run, Job: job}
		if _, err := s.publish(request.Context(), marker); err != nil {
			s.internalError(response, err)
			return
		}
		forward = s.shouldForwardRepository(request.Context(), payload.Repository.FullName, receivedAt)
	}
	if forward {
		s.forwardWebhook(request.Context(), body, request.Header)
	}
	response.WriteHeader(status)
	response.Write([]byte(message))
}

func (s *Server) shouldForwardRepository(ctx context.Context, repo string, receivedAt time.Time) bool {
	if s.forwardRepoDiscoveryUntil.IsZero() {
		return true
	}
	if receivedAt.Before(s.forwardRepoDiscoveryUntil) {
		if err := s.store.RememberLegacyForwardRepo(ctx, repo); err != nil {
			s.logger.Warn("legacy forwarding eligibility failed")
		}
		return true
	}
	eligible, err := s.store.IsLegacyForwardRepo(ctx, repo)
	if err != nil {
		s.logger.Warn("legacy forwarding eligibility failed")
		return false
	}
	return eligible
}

func (s *Server) forwardWebhook(ctx context.Context, body []byte, source http.Header) {
	if s.forwardWebhookURL == "" {
		return
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, s.forwardWebhookURL, bytes.NewReader(body))
	if err != nil {
		s.logger.Warn("relay webhook forwarding failed")
		return
	}
	for name, values := range source {
		lowerName := strings.ToLower(name)
		if lowerName != "content-type" && lowerName != "x-hub-signature-256" && !strings.HasPrefix(lowerName, "x-github-") {
			continue
		}
		for _, value := range values {
			request.Header.Add(name, value)
		}
	}
	response, err := s.forwardClient.Do(request)
	if err != nil {
		s.logger.Warn("relay webhook forwarding failed")
		return
	}
	_, drainErr := io.Copy(io.Discard, io.LimitReader(response.Body, forwardResponseLimit))
	closeErr := response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices || drainErr != nil || closeErr != nil {
		s.logger.Warn("relay webhook forwarding failed")
	}
}

func validSignature(secret, body []byte, header string) bool {
	if !strings.HasPrefix(header, "sha256=") {
		return false
	}
	claimed, err := hex.DecodeString(strings.TrimPrefix(header, "sha256="))
	if err != nil || len(claimed) != sha256.Size {
		return false
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write(body)
	return hmac.Equal(mac.Sum(nil), claimed)
}

func (s *Server) publish(ctx context.Context, marker Marker) (Marker, error) {
	s.publishMu.Lock()
	stored, err := s.store.Append(ctx, marker)
	if err != nil {
		s.publishMu.Unlock()
		return Marker{}, err
	}
	for subscriber := range s.subscribers {
		if _, allowed := subscriber.repos[stored.Repo]; !allowed {
			continue
		}
		select {
		case <-subscriber.done:
			s.removeSubscriberLocked(subscriber)
		case subscriber.queue <- stored:
		default:
			s.removeSubscriberLocked(subscriber)
		}
	}
	s.publishMu.Unlock()
	s.maybeCleanup(ctx)
	return stored, nil
}

func (s *Server) maybeCleanup(ctx context.Context) {
	now := time.Now()
	next := s.cleanupAfter.Load()
	if now.UnixNano() < next || !s.cleanupAfter.CompareAndSwap(next, now.Add(cleanupInterval).UnixNano()) {
		return
	}
	if _, err := s.store.Cleanup(ctx); err != nil {
		s.logger.Warn("relay cleanup failed", "error", err)
	}
}

func (s *Server) handleEvents(response http.ResponseWriter, request *http.Request) {
	token, ok := bearerToken(request)
	if !ok {
		http.Error(response, "unauthorized", http.StatusUnauthorized)
		return
	}
	latest, _, err := s.store.LatestBounds(request.Context())
	if err != nil {
		s.internalError(response, err)
		return
	}
	raw := request.URL.Query().Get("since")
	if raw == "" {
		writeJSON(response, http.StatusOK, map[string]any{"latest": latest, "events": []Marker{}})
		return
	}
	since, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || since < 0 || since > latest {
		writeJSON(response, http.StatusOK, map[string]any{"latest": latest, "events": []Marker{}})
		return
	}
	markers, err := s.store.Replay(request.Context(), since, replayPage)
	if err != nil {
		s.internalError(response, err)
		return
	}
	delivered := latest
	if len(markers) > 0 {
		delivered = markers[len(markers)-1].Seq
	}
	filtered, status, err := s.filterReadable(request.Context(), token, markers)
	if err != nil {
		s.internalError(response, err)
		return
	}
	if status != 0 {
		http.Error(response, http.StatusText(status), status)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"latest": delivered, "events": filtered})
}

func (s *Server) filterReadable(ctx context.Context, token string, markers []Marker) ([]Marker, int, error) {
	verdicts := make(map[string]bool)
	result := make([]Marker, 0, len(markers))
	for _, marker := range markers {
		readable, known := verdicts[marker.Repo]
		if !known {
			var err error
			readable, err = s.access.Readable(ctx, token, marker.Repo)
			if err != nil {
				return nil, accessStatus(err), nil
			}
			verdicts[marker.Repo] = readable
		}
		if readable {
			result = append(result, marker)
		}
	}
	return result, 0, nil
}
func accessStatus(err error) int {
	if errors.Is(err, errBadToken) {
		return http.StatusUnauthorized
	}
	return http.StatusServiceUnavailable
}

func (s *Server) handleCoverage(response http.ResponseWriter, request *http.Request) {
	token, ok := bearerToken(request)
	if !ok {
		http.Error(response, "unauthorized", http.StatusUnauthorized)
		return
	}
	repos, err := normalizeRepos(strings.Split(request.URL.Query().Get("repos"), ","))
	if err != nil {
		http.Error(response, err.Error(), http.StatusBadRequest)
		return
	}
	known, err := s.store.CoverageFor(request.Context(), repos)
	if err != nil {
		s.internalError(response, err)
		return
	}
	result := make(map[string]bool, len(repos))
	for _, repo := range repos {
		if !known[repo] {
			result[repo] = false
			continue
		}
		readable, err := s.access.Readable(request.Context(), token, repo)
		if err != nil {
			status := accessStatus(err)
			http.Error(response, http.StatusText(status), status)
			return
		}
		result[repo] = readable
	}
	writeJSON(response, http.StatusOK, map[string]any{"repos": result})
}

func (s *Server) handleSession(response http.ResponseWriter, request *http.Request) {
	token, ok := bearerToken(request)
	if !ok {
		http.Error(response, "unauthorized", http.StatusUnauthorized)
		return
	}
	release, ok := s.acquireBodyReader(response)
	if !ok {
		return
	}
	var input sessionRequest
	decoder := json.NewDecoder(http.MaxBytesReader(response, request.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		release()
		http.Error(response, "invalid JSON", http.StatusBadRequest)
		return
	}
	err := decoder.Decode(&struct{}{})
	release()
	if err != io.EOF {
		http.Error(response, "invalid JSON", http.StatusBadRequest)
		return
	}
	repos, err := normalizeRepos(input.Repos)
	if err != nil {
		http.Error(response, err.Error(), http.StatusBadRequest)
		return
	}
	known, err := s.store.CoverageFor(request.Context(), repos)
	if err != nil {
		s.internalError(response, err)
		return
	}
	allowed := make([]string, 0, len(repos))
	coverage := make(map[string]bool, len(repos))
	var authExpires time.Time
	for _, repo := range repos {
		readable, expires, err := s.access.ReadableUntil(request.Context(), token, repo)
		if err != nil {
			status := accessStatus(err)
			http.Error(response, http.StatusText(status), status)
			return
		}
		if readable {
			allowed = append(allowed, repo)
			if authExpires.IsZero() || expires.Before(authExpires) {
				authExpires = expires
			}
		}
		coverage[repo] = readable && known[repo]
	}
	activityRepos := make([]string, 0, len(allowed))
	for _, repo := range allowed {
		if coverage[repo] {
			activityRepos = append(activityRepos, repo)
		}
	}
	if len(allowed) == 0 {
		http.Error(response, "no readable repositories", http.StatusForbidden)
		return
	}
	identity, identityExpires, err := s.access.Identity(request.Context(), token)
	if err != nil {
		status := accessStatus(err)
		http.Error(response, http.StatusText(status), status)
		return
	}
	if identityExpires.Before(authExpires) {
		authExpires = identityExpires
	}
	ticket, err := s.tickets.Issue(strconv.FormatInt(identity.ID, 10), allowed, authExpires)
	if err != nil {
		http.Error(response, "session capacity reached", http.StatusServiceUnavailable)
		return
	}
	if err := s.store.RecordActivity(request.Context(), identity, activityRepos, time.Now()); err != nil {
		s.logger.Warn("record relay activity failed", "error", err)
	}
	s.maybeCleanup(request.Context())
	writeJSON(response, http.StatusOK, map[string]any{"ticket": ticket, "expiresAt": authExpires.UnixMilli(), "repos": coverage})
}

func (s *Server) handleStream(response http.ResponseWriter, request *http.Request) {
	if !websocket.IsWebSocketUpgrade(request) {
		http.Error(response, "websocket upgrade required", http.StatusUpgradeRequired)
		return
	}
	cursor, hasCursor, valid := parseCursor(request.URL.Query().Get("since"))
	if !valid {
		http.Error(response, "invalid cursor", http.StatusBadRequest)
		return
	}
	ticket := request.URL.Query().Get("ticket")
	session, ok := s.tickets.Consume(ticket)
	if !ok {
		http.Error(response, "invalid ticket", http.StatusUnauthorized)
		return
	}
	subscriber, replay, initial, err := s.subscribe(request.Context(), session, cursor, hasCursor)
	if errors.Is(err, errSubscriberCapacity) {
		http.Error(response, "stream capacity reached", http.StatusServiceUnavailable)
		return
	}
	if err != nil {
		s.internalError(response, err)
		return
	}
	connection, err := s.upgrader.Upgrade(response, request, nil)
	if err != nil {
		s.unsubscribe(subscriber)
		return
	}
	defer s.unsubscribe(subscriber)
	s.serveConnection(connection, subscriber, replay, initial)
}

func parseCursor(raw string) (int64, bool, bool) {
	if raw == "" {
		return 0, false, true
	}
	cursor, err := strconv.ParseInt(raw, 10, 64)
	return cursor, true, err == nil && cursor >= 0
}

func (s *Server) subscribe(ctx context.Context, session ticketSession, cursor int64, hasCursor bool) (*subscriber, []Marker, readyFrame, error) {
	s.publishMu.Lock()
	defer s.publishMu.Unlock()
	if len(s.subscribers) >= maxSubscribers || s.principalStreams[session.principal] >= maxPrincipalStreams {
		return nil, nil, readyFrame{}, errSubscriberCapacity
	}
	var latest, oldest int64
	replay := []Marker{}
	var err error
	if hasCursor {
		latest, oldest, replay, err = s.store.ReplaySnapshot(ctx, cursor, maxReplayBacklog+1)
	} else {
		latest, oldest, err = s.store.LatestBounds(ctx)
	}
	if err != nil {
		return nil, nil, readyFrame{}, err
	}
	initial := readyFrame{Type: "ready", Latest: latest}
	tooOld := latest > cursor && (oldest == 0 || cursor < oldest-1)
	if hasCursor && (cursor > latest || tooOld || len(replay) > maxReplayBacklog) {
		initial.Type = "reset"
		replay = nil
	}
	subscriber := &subscriber{
		principal: session.principal, repos: session.repos, authExpires: session.authExpires,
		queue: make(chan Marker, subscriberBuffer), done: make(chan struct{}),
	}
	s.subscribers[subscriber] = struct{}{}
	s.principalStreams[subscriber.principal]++
	return subscriber, replay, initial, nil
}
func (s *Server) removeSubscriberLocked(subscriber *subscriber) {
	if _, exists := s.subscribers[subscriber]; exists {
		delete(s.subscribers, subscriber)
		s.principalStreams[subscriber.principal]--
		if s.principalStreams[subscriber.principal] == 0 {
			delete(s.principalStreams, subscriber.principal)
		}
	}
	subscriber.stop()
}

func (s *Server) unsubscribe(subscriber *subscriber) {
	s.publishMu.Lock()
	s.removeSubscriberLocked(subscriber)
	s.publishMu.Unlock()
}

func (s *Server) serveConnection(connection *websocket.Conn, subscriber *subscriber, replay []Marker, initial readyFrame) {
	defer connection.Close()
	authDuration := time.Until(subscriber.authExpires)
	if authDuration <= 0 {
		connection.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "authorization expired"), time.Now().Add(time.Second))
		return
	}
	authTimer := time.NewTimer(authDuration)
	defer authTimer.Stop()
	connection.SetReadLimit(1024)
	connection.SetReadDeadline(time.Now().Add(60 * time.Second))
	connection.SetPongHandler(func(string) error {
		connection.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		for {
			if _, _, err := connection.ReadMessage(); err != nil {
				return
			}
		}
	}()
	write := func(value any) bool {
		connection.SetWriteDeadline(time.Now().Add(10 * time.Second))
		return connection.WriteJSON(value) == nil
	}
	if !write(initial) {
		return
	}
	for _, marker := range replay {
		select {
		case <-authTimer.C:
			connection.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "authorization expired"), time.Now().Add(time.Second))
			return
		case <-subscriber.done:
			connection.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseTryAgainLater, "subscriber fell behind"), time.Now().Add(time.Second))
			return
		default:
		}
		if _, allowed := subscriber.repos[marker.Repo]; allowed && !write(markerFrame{Type: "marker", Marker: marker}) {
			return
		}
	}
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-readDone:
			return
		case <-subscriber.done:
			connection.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseTryAgainLater, "subscriber fell behind"), time.Now().Add(time.Second))
			return
		case marker := <-subscriber.queue:
			if !time.Now().Before(subscriber.authExpires) {
				connection.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "authorization expired"), time.Now().Add(time.Second))
				return
			}
			if !write(markerFrame{Type: "marker", Marker: marker}) {
				return
			}
		case <-authTimer.C:
			connection.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "authorization expired"), time.Now().Add(time.Second))
			return
		case <-ping.C:
			connection.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if connection.WriteMessage(websocket.PingMessage, nil) != nil {
				return
			}
		}
	}
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	json.NewEncoder(response).Encode(value)
}

func (s *Server) internalError(response http.ResponseWriter, err error) {
	s.logger.Error("relay request failed", "error", err)
	http.Error(response, "internal server error", http.StatusInternalServerError)
}

func (s *Server) Shutdown() {
	s.publishMu.Lock()
	for subscriber := range s.subscribers {
		s.removeSubscriberLocked(subscriber)
	}
	s.publishMu.Unlock()
}
