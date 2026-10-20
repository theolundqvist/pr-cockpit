package relay

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

const (
	anchorRotationAge    = 24 * time.Hour
	anchorRotationPushes = 80
	anchorGrace          = time.Hour
	anchorEventMaxAge    = 10 * time.Minute
	anchorSessionTTL     = 24 * time.Hour
	maxAnchorRepos       = 50
	maxAnchorIDs         = 100
	maxAnchorBody        = 1 << 20
)

var (
	validSHA     = regexp.MustCompile(`^[0-9a-f]{40}$`)
	validInstall = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)
)

type relayAnchor struct {
	anchorID     string
	proof        string
	prevAnchorID string
	prevProof    string
	prevUntil    time.Time
}

// anchorChange describes a replaced anchor: grants on proof stay, grants on prevProof end at
// prevUntil, and every other grant for the repository ends immediately.
type anchorChange struct {
	proof     string
	prevProof string
	prevUntil time.Time
}

type anchorRepository struct {
	ID            int64  `json:"id"`
	FullName      string `json:"full_name"`
	DefaultBranch string `json:"default_branch"`
	// Push payloads carry Unix seconds; other events use RFC3339 strings.
	PushedAt json.RawMessage `json:"pushed_at"`
}

type anchorCommit struct {
	ID     string `json:"id"`
	TreeID string `json:"tree_id"`
}

type pushPayload struct {
	Ref        string            `json:"ref"`
	After      string            `json:"after"`
	Deleted    bool              `json:"deleted"`
	HeadCommit *anchorCommit     `json:"head_commit"`
	Repository *anchorRepository `json:"repository"`
}

type checkSuitePayload struct {
	CheckSuite *struct {
		HeadBranch string        `json:"head_branch"`
		HeadSHA    string        `json:"head_sha"`
		HeadCommit *anchorCommit `json:"head_commit"`
		UpdatedAt  string        `json:"updated_at"`
	} `json:"check_suite"`
	Repository *anchorRepository `json:"repository"`
}

// anchorCandidate is a default-branch head observed in a fresh webhook delivery.
type anchorCandidate struct {
	repo   string
	repoID int64
	after  string
	tree   string
}

type anchorsRequest struct {
	Repos map[string][]string `json:"repos"`
}

type rotateFrame struct {
	Type string `json:"type"`
	Repo string `json:"repo"`
}

func anchorKey(repo string) string { return strings.ToLower(repo) }

func anchorID(key string, repoID int64, after string) string {
	digest := sha256.Sum256([]byte("pr-cockpit-relay anchor\n" + key + "\n" + strconv.FormatInt(repoID, 10) + "\n" + after))
	return hex.EncodeToString(digest[:])
}

func anchorProof(key string, repoID int64, after, tree string) string {
	digest := sha256.Sum256([]byte("pr-cockpit-relay proof\n" + key + "\n" + strconv.FormatInt(repoID, 10) + "\n" + after + "\n" + tree))
	return hex.EncodeToString(digest[:])
}

func constantTimeEqual(left, right string) bool {
	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

func (a relayAnchor) prevValid(now time.Time) bool {
	return a.prevProof != "" && now.Before(a.prevUntil)
}

func (a relayAnchor) matchID(ids []string, now time.Time) (string, bool) {
	prevValid := a.prevValid(now)
	for _, id := range ids {
		if constantTimeEqual(id, a.anchorID) {
			return a.anchorID, true
		}
	}
	if prevValid {
		for _, id := range ids {
			if constantTimeEqual(id, a.prevAnchorID) {
				return a.prevAnchorID, true
			}
		}
	}
	return "", false
}

// verifyProof returns how long proof grants access, or false when it grants none.
func (a relayAnchor) verifyProof(proof string, now, sessionExpires time.Time) (time.Time, bool) {
	if constantTimeEqual(proof, a.proof) {
		return sessionExpires, true
	}
	if a.prevValid(now) && constantTimeEqual(proof, a.prevProof) {
		return a.prevUntil, true
	}
	return time.Time{}, false
}

// restrict caps grant for a replaced anchor and reports whether it was affected.
func (c anchorChange) restrict(grant repoGrant, now time.Time) (repoGrant, bool) {
	if grant.proof != "" && grant.proof == c.proof {
		return grant, false
	}
	limit := now
	if c.prevProof != "" && grant.proof == c.prevProof {
		limit = c.prevUntil
	}
	if limit.Before(grant.expires) {
		grant.expires = limit
	}
	return grant, true
}

func pushedAt(raw json.RawMessage) (time.Time, bool) {
	var seconds int64
	if err := json.Unmarshal(raw, &seconds); err == nil {
		return time.Unix(seconds, 0), true
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return time.Time{}, false
	}
	parsed, err := time.Parse(time.RFC3339, text)
	return parsed, err == nil
}

// pushCandidate and checkSuiteCandidate accept only fresh default-branch heads with a tree.
func pushCandidate(body []byte, receivedAt time.Time) (anchorCandidate, bool) {
	var push pushPayload
	if err := json.Unmarshal(body, &push); err != nil || push.Repository == nil || push.HeadCommit == nil || push.Deleted ||
		push.Ref != "refs/heads/"+push.Repository.DefaultBranch || push.HeadCommit.ID != push.After {
		return anchorCandidate{}, false
	}
	at, ok := pushedAt(push.Repository.PushedAt)
	return newAnchorCandidate(push.Repository, *push.HeadCommit, at, ok, receivedAt)
}

func checkSuiteCandidate(body []byte, receivedAt time.Time) (anchorCandidate, bool) {
	var event checkSuitePayload
	if err := json.Unmarshal(body, &event); err != nil || event.Repository == nil || event.CheckSuite == nil {
		return anchorCandidate{}, false
	}
	suite := event.CheckSuite
	if suite.HeadCommit == nil || suite.HeadBranch != event.Repository.DefaultBranch || suite.HeadCommit.ID != suite.HeadSHA {
		return anchorCandidate{}, false
	}
	at, err := time.Parse(time.RFC3339, suite.UpdatedAt)
	return newAnchorCandidate(event.Repository, *suite.HeadCommit, at, err == nil, receivedAt)
}

func newAnchorCandidate(repository *anchorRepository, commit anchorCommit, at time.Time, dated bool, receivedAt time.Time) (anchorCandidate, bool) {
	if repository.ID <= 0 || repository.DefaultBranch == "" || !validSHA.MatchString(commit.ID) || !validSHA.MatchString(commit.TreeID) ||
		!dated || at.Before(receivedAt.Add(-anchorEventMaxAge)) {
		return anchorCandidate{}, false
	}
	return anchorCandidate{repo: repository.FullName, repoID: repository.ID, after: commit.ID, tree: commit.TreeID}, true
}

func (s *Server) captureAnchor(ctx context.Context, event string, body []byte, receivedAt time.Time) {
	var candidate anchorCandidate
	var ok bool
	switch event {
	case "push":
		candidate, ok = pushCandidate(body, receivedAt)
	case "check_suite":
		candidate, ok = checkSuiteCandidate(body, receivedAt)
	}
	if !ok {
		return
	}
	s.publishMu.Lock()
	defer s.publishMu.Unlock()
	change, changed, err := s.store.CaptureAnchor(ctx, anchorKey(candidate.repo), candidate.repoID, candidate.after, candidate.tree, receivedAt)
	if err != nil {
		s.logger.Warn("relay anchor capture failed", "error", err)
		return
	}
	if changed {
		s.revokeAnchorLocked(candidate.repo, change, receivedAt)
	}
}

// updateInstallation deletes and revokes under publishMu for the same reasons as captureAnchor.
func (s *Server) updateInstallation(ctx context.Context, event string, payload webhookPayload, now time.Time) error {
	s.publishMu.Lock()
	defer s.publishMu.Unlock()
	removed, err := s.store.UpdateInstallation(ctx, event, payload)
	if err != nil {
		return err
	}
	for _, repo := range removed {
		s.revokeAnchorLocked(repo, anchorChange{}, now)
	}
	return nil
}

// revokeAnchorLocked runs under publishMu together with the anchor write, so rotations revoke in
// write order, no publish reaches old readers in between, and a concurrent proof session either
// sees the new anchor or has its ticket restricted here.
func (s *Server) revokeAnchorLocked(repo string, change anchorChange, now time.Time) {
	key := anchorKey(repo)
	s.tickets.restrict(key, change, now)
	for subscriber := range s.subscribers {
		if !subscriber.anchored || !subscriber.restrict(key, change, now) {
			continue
		}
		select {
		case <-subscriber.done:
			s.removeSubscriberLocked(subscriber)
		case subscriber.rotations <- repo:
		default:
			s.removeSubscriberLocked(subscriber)
		}
	}
}

func (s *Server) handleAnchors(response http.ResponseWriter, request *http.Request) {
	release, ok := s.acquireBodyReader(response)
	if !ok {
		return
	}
	var input anchorsRequest
	err := decodeStrictJSON(http.MaxBytesReader(response, request.Body, maxAnchorBody), &input)
	release()
	if err != nil {
		http.Error(response, "invalid JSON", http.StatusBadRequest)
		return
	}
	if len(input.Repos) == 0 || len(input.Repos) > maxAnchorRepos {
		http.Error(response, "between 1 and 50 repositories are required", http.StatusBadRequest)
		return
	}
	keys := make([]string, 0, len(input.Repos))
	for repo, ids := range input.Repos {
		if !validRepo.MatchString(repo) {
			http.Error(response, "invalid repository", http.StatusBadRequest)
			return
		}
		if len(ids) > maxAnchorIDs {
			http.Error(response, "at most 100 anchor ids per repository are allowed", http.StatusBadRequest)
			return
		}
		keys = append(keys, anchorKey(repo))
	}
	anchors, err := s.store.Anchors(request.Context(), keys)
	if err != nil {
		s.internalError(response, err)
		return
	}
	now := s.now()
	result := make(map[string]*string, len(input.Repos))
	for repo, ids := range input.Repos {
		result[repo] = nil
		if anchor, ok := anchors[anchorKey(repo)]; ok {
			if id, ok := anchor.matchID(ids, now); ok {
				result[repo] = &id
			}
		}
	}
	writeJSON(response, http.StatusOK, map[string]any{"repos": result})
}

func (s *Server) handleProofSession(response http.ResponseWriter, request *http.Request, input sessionRequest) {
	if len(input.Proofs) == 0 || len(input.Proofs) > maxAnchorRepos {
		http.Error(response, "between 1 and 50 repositories are required", http.StatusBadRequest)
		return
	}
	if input.Install != nil && !validInstall.MatchString(*input.Install) {
		http.Error(response, "invalid install id", http.StatusBadRequest)
		return
	}
	keys := make([]string, 0, len(input.Proofs))
	for repo := range input.Proofs {
		key := anchorKey(repo)
		if slices.Contains(keys, key) || !validRepo.MatchString(repo) {
			http.Error(response, "invalid repository", http.StatusBadRequest)
			return
		}
		keys = append(keys, key)
	}
	session, err := s.issueProofTicket(request.Context(), input, keys)
	if errors.Is(err, errTicketCapacity) {
		http.Error(response, "session capacity reached", http.StatusServiceUnavailable)
		return
	}
	if err != nil {
		s.internalError(response, err)
		return
	}
	if len(session.allowed) == 0 {
		http.Error(response, "no readable repositories", http.StatusForbidden)
		return
	}
	if input.User != nil && input.User.ID > 0 {
		if err := s.store.RecordActivity(request.Context(), *input.User, session.allowed, s.now()); err != nil {
			s.logger.Warn("record relay activity failed", "error", err)
		}
	}
	s.maybeCleanup(request.Context())
	writeJSON(response, http.StatusOK, map[string]any{"ticket": session.ticket, "expiresAt": session.authExpires.UnixMilli(), "repos": session.coverage})
}

type proofSession struct {
	ticket      string
	authExpires time.Time
	coverage    map[string]bool
	allowed     []string
}

// issueProofTicket verifies and issues under publishMu so a concurrent rotation either precedes
// the anchor read or restricts the issued ticket; see revokeAnchor.
func (s *Server) issueProofTicket(ctx context.Context, input sessionRequest, keys []string) (proofSession, error) {
	s.publishMu.Lock()
	defer s.publishMu.Unlock()
	anchors, err := s.store.Anchors(ctx, keys)
	if err != nil {
		return proofSession{}, err
	}
	now := s.now()
	sessionExpires := now.Add(anchorSessionTTL)
	session := proofSession{authExpires: sessionExpires, coverage: make(map[string]bool, len(input.Proofs)), allowed: make([]string, 0, len(input.Proofs))}
	grants := make(map[string]repoGrant, len(input.Proofs))
	validProofs := make([]string, 0, len(input.Proofs))
	for repo, proof := range input.Proofs {
		anchor, ok := anchors[anchorKey(repo)]
		if !ok {
			session.coverage[repo] = false
			continue
		}
		expires, valid := anchor.verifyProof(proof, now, sessionExpires)
		session.coverage[repo] = valid
		if !valid {
			continue
		}
		grants[anchorKey(repo)] = repoGrant{proof: proof, expires: expires}
		session.allowed = append(session.allowed, repo)
		validProofs = append(validProofs, proof)
		if expires.Before(session.authExpires) {
			session.authExpires = expires
		}
	}
	if len(session.allowed) == 0 {
		return session, nil
	}
	var principal string
	if input.Install != nil {
		principal = "install:" + *input.Install
	} else {
		slices.Sort(validProofs)
		digest := sha256.Sum256([]byte(strings.Join(validProofs, "\n")))
		principal = "anchors:" + hex.EncodeToString(digest[:])
	}
	session.ticket, err = s.tickets.IssueAnchored(principal, grants, session.authExpires)
	return session, err
}
