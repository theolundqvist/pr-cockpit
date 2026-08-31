package relay

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	authTTL                = 15 * time.Minute
	ticketTTL              = time.Minute
	identityRequestTimeout = 10 * time.Second
	maxTickets             = 4096
	maxPrincipalTickets    = 16
	accessConcurrency      = 32
)

var validRepo = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

type accessVerdict struct {
	readable bool
	expires  time.Time
}

type GitHubIdentity struct {
	ID    int64  `json:"id"`
	Login string `json:"login"`
}

type identityVerdict struct {
	identity GitHubIdentity
	expires  time.Time
}

type accessCall struct {
	done     chan struct{}
	readable bool
	expires  time.Time
	err      error
}

type identityCall struct {
	done     chan struct{}
	identity GitHubIdentity
	expires  time.Time
	err      error
}

type AccessChecker struct {
	client        *http.Client
	baseURL       string
	mu            sync.Mutex
	cache         map[string]accessVerdict
	calls         map[string]*accessCall
	identityCache map[string]identityVerdict
	identityCalls map[string]*identityCall
	semaphore     chan struct{}
	nextSweep     time.Time
}

func NewAccessChecker(client *http.Client, baseURL string) *AccessChecker {
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	return &AccessChecker{
		client: client, baseURL: strings.TrimRight(baseURL, "/"),
		cache: make(map[string]accessVerdict), calls: make(map[string]*accessCall),
		identityCache: make(map[string]identityVerdict), identityCalls: make(map[string]*identityCall),
		semaphore: make(chan struct{}, accessConcurrency),
	}
}

var (
	errBadToken       = errors.New("bad token")
	errAccessBusy     = errors.New("GitHub access validation busy")
	errTicketCapacity = errors.New("session ticket capacity reached")
)

func (a *AccessChecker) Readable(ctx context.Context, token, repo string) (bool, error) {
	readable, _, err := a.ReadableUntil(ctx, token, repo)
	return readable, err
}

func (a *AccessChecker) ReadableUntil(ctx context.Context, token, repo string) (bool, time.Time, error) {
	key := tokenHash(token) + ":" + repo
	now := time.Now()
	a.mu.Lock()
	a.sweepLocked(now)
	if cached, ok := a.cache[key]; ok && cached.expires.After(now) {
		a.mu.Unlock()
		return cached.readable, cached.expires, nil
	}
	if call, ok := a.calls[key]; ok {
		a.mu.Unlock()
		select {
		case <-ctx.Done():
			return false, time.Time{}, ctx.Err()
		case <-call.done:
			return call.readable, call.expires, call.err
		}
	}
	call := &accessCall{done: make(chan struct{})}
	a.calls[key] = call
	a.mu.Unlock()

	readable, cache, err := a.check(ctx, token, repo)
	var expires time.Time
	a.mu.Lock()
	if cache {
		expires = time.Now().Add(authTTL)
		a.cache[key] = accessVerdict{readable: readable, expires: expires}
	}
	call.readable, call.expires, call.err = readable, expires, err
	delete(a.calls, key)
	close(call.done)
	a.mu.Unlock()
	return readable, expires, err
}

func (a *AccessChecker) sweepLocked(now time.Time) {
	if a.nextSweep.After(now) {
		return
	}
	for cacheKey, verdict := range a.cache {
		if !verdict.expires.After(now) {
			delete(a.cache, cacheKey)
		}
	}
	for cacheKey, verdict := range a.identityCache {
		if !verdict.expires.After(now) {
			delete(a.identityCache, cacheKey)
		}
	}
	a.nextSweep = now.Add(authTTL)
}

func (a *AccessChecker) Identity(ctx context.Context, token string) (GitHubIdentity, time.Time, error) {
	key := tokenHash(token)
	now := time.Now()
	a.mu.Lock()
	a.sweepLocked(now)
	if cached, ok := a.identityCache[key]; ok && cached.expires.After(now) {
		a.mu.Unlock()
		return cached.identity, cached.expires, nil
	}
	call, ok := a.identityCalls[key]
	if !ok {
		call = &identityCall{done: make(chan struct{})}
		a.identityCalls[key] = call
		go a.resolveIdentityCall(key, token, call)
	}
	a.mu.Unlock()
	select {
	case <-ctx.Done():
		return GitHubIdentity{}, time.Time{}, ctx.Err()
	case <-call.done:
		return call.identity, call.expires, call.err
	}
}

func (a *AccessChecker) resolveIdentityCall(key, token string, call *identityCall) {
	ctx, cancel := context.WithTimeout(context.Background(), identityRequestTimeout)
	defer cancel()
	identity, err := a.resolveIdentity(ctx, token)
	var expires time.Time
	a.mu.Lock()
	if err == nil {
		expires = time.Now().Add(authTTL)
		a.identityCache[key] = identityVerdict{identity: identity, expires: expires}
	}
	call.identity, call.expires, call.err = identity, expires, err
	delete(a.identityCalls, key)
	close(call.done)
	a.mu.Unlock()
}

func (a *AccessChecker) resolveIdentity(ctx context.Context, token string) (GitHubIdentity, error) {
	select {
	case a.semaphore <- struct{}{}:
		defer func() { <-a.semaphore }()
	default:
		return GitHubIdentity{}, errAccessBusy
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.baseURL+"/user", nil)
	if err != nil {
		return GitHubIdentity{}, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "pr-cockpit-relay")
	response, err := a.client.Do(req)
	if err != nil {
		return GitHubIdentity{}, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized {
		io.Copy(io.Discard, response.Body)
		return GitHubIdentity{}, errBadToken
	}
	if response.StatusCode != http.StatusOK {
		io.Copy(io.Discard, response.Body)
		return GitHubIdentity{}, fmt.Errorf("GitHub identity returned %s", response.Status)
	}
	var identity GitHubIdentity
	if err := json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&identity); err != nil {
		return GitHubIdentity{}, fmt.Errorf("decode GitHub identity: %w", err)
	}
	if identity.ID <= 0 || identity.Login == "" {
		return GitHubIdentity{}, errors.New("GitHub identity is incomplete")
	}
	return identity, nil
}

func (a *AccessChecker) check(ctx context.Context, token, repo string) (bool, bool, error) {
	select {
	case a.semaphore <- struct{}{}:
		defer func() { <-a.semaphore }()
	default:
		return false, false, errAccessBusy
	}
	parts := strings.SplitN(repo, "/", 2)
	if len(parts) != 2 {
		return false, false, errors.New("invalid repository")
	}
	endpoint := a.baseURL + "/repos/" + url.PathEscape(parts[0]) + "/" + url.PathEscape(parts[1])
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return false, false, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "pr-cockpit-relay")
	response, err := a.client.Do(req)
	if err != nil {
		return false, false, err
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()
	switch response.StatusCode {
	case http.StatusOK:
		return true, true, nil
	case http.StatusNotFound:
		return false, true, nil
	case http.StatusUnauthorized:
		return false, false, errBadToken
	default:
		return false, false, fmt.Errorf("GitHub repository access returned %s", response.Status)
	}
}

func tokenHash(token string) string {
	digest := sha256.Sum256([]byte(token))
	return hex.EncodeToString(digest[:])
}

type ticketSession struct {
	principal        string
	repos            map[string]struct{}
	admissionExpires time.Time
	authExpires      time.Time
}

type Tickets struct {
	mu               sync.Mutex
	sessions         map[string]ticketSession
	principalTickets map[string]int
	nextSweep        time.Time
}

func NewTickets() *Tickets {
	return &Tickets{
		sessions:         make(map[string]ticketSession),
		principalTickets: make(map[string]int),
	}
}

func (t *Tickets) Issue(principal string, repos []string, authExpires time.Time) (ticket string, err error) {
	bytes := make([]byte, 32)
	if _, err = rand.Read(bytes); err != nil {
		return "", fmt.Errorf("create ticket: %w", err)
	}
	ticket = base64.RawURLEncoding.EncodeToString(bytes)
	now := time.Now()
	admissionExpires := now.Add(ticketTTL)
	if authExpires.Before(admissionExpires) {
		admissionExpires = authExpires
	}
	repoSet := make(map[string]struct{}, len(repos))
	for _, repo := range repos {
		repoSet[repo] = struct{}{}
	}
	session := ticketSession{
		principal: principal, repos: repoSet,
		admissionExpires: admissionExpires, authExpires: authExpires,
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.nextSweep.After(now) {
		t.sweep(now)
		t.nextSweep = now.Add(time.Minute)
	}
	if len(t.sessions) >= maxTickets || t.principalTickets[principal] >= maxPrincipalTickets {
		return "", errTicketCapacity
	}
	t.sessions[tokenHash(ticket)] = session
	t.principalTickets[principal]++
	return ticket, nil
}

func (t *Tickets) sweep(now time.Time) {
	for key, session := range t.sessions {
		if !session.admissionExpires.After(now) {
			t.removeLocked(key, session)
		}
	}
}

func (t *Tickets) removeLocked(key string, session ticketSession) {
	delete(t.sessions, key)
	t.principalTickets[session.principal]--
	if t.principalTickets[session.principal] == 0 {
		delete(t.principalTickets, session.principal)
	}
}

func (t *Tickets) Consume(ticket string) (ticketSession, bool) {
	hash := tokenHash(ticket)
	t.mu.Lock()
	defer t.mu.Unlock()
	session, ok := t.sessions[hash]
	if ok {
		t.removeLocked(hash, session)
	}
	now := time.Now()
	if !ok || !session.admissionExpires.After(now) || !session.authExpires.After(now) {
		return ticketSession{}, false
	}
	return session, true
}

func bearerToken(request *http.Request) (string, bool) {
	authorization := request.Header.Get("Authorization")
	if !strings.HasPrefix(authorization, "Bearer ") {
		return "", false
	}
	token := strings.TrimSpace(strings.TrimPrefix(authorization, "Bearer "))
	return token, token != ""
}

func normalizeRepos(repos []string) ([]string, error) {
	if len(repos) > 50 {
		return nil, errors.New("at most 50 repositories are allowed")
	}
	result := make([]string, 0, len(repos))
	seen := make(map[string]struct{}, len(repos))
	for _, raw := range repos {
		repo := strings.TrimSpace(raw)
		if repo == "" {
			continue
		}
		if !validRepo.MatchString(repo) {
			return nil, fmt.Errorf("invalid repository %q", repo)
		}
		if _, exists := seen[repo]; exists {
			continue
		}
		seen[repo] = struct{}{}
		result = append(result, repo)
	}
	if len(result) == 0 {
		return nil, errors.New("at least one repository is required")
	}
	return result, nil
}
