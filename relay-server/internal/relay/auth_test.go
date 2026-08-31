package relay

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

type observedContext struct {
	context.Context
	observed chan<- struct{}
}

func (c observedContext) Done() <-chan struct{} {
	select {
	case c.observed <- struct{}{}:
	default:
	}
	return c.Context.Done()
}

func TestAccessCheckerCachesOnlyDefinitiveVerdicts(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusNotFound} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			calls := 0
			github := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				calls++
				response.WriteHeader(status)
			}))
			defer github.Close()
			checker := NewAccessChecker(github.Client(), github.URL)
			for range 2 {
				readable, err := checker.Readable(context.Background(), "token", "owner/repo")
				if err != nil {
					t.Fatal(err)
				}
				if readable != (status == http.StatusOK) {
					t.Fatalf("readable = %v for %d", readable, status)
				}
			}
			if calls != 1 {
				t.Fatalf("GitHub calls = %d, want cached verdict", calls)
			}
		})
	}
}

func TestAccessCheckerDoesNotCacheTemporaryFailures(t *testing.T) {
	for _, status := range []int{http.StatusForbidden, http.StatusTooManyRequests, http.StatusInternalServerError, http.StatusTeapot} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			calls := 0
			github := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				calls++
				response.WriteHeader(status)
			}))
			defer github.Close()
			checker := NewAccessChecker(github.Client(), github.URL)
			for range 2 {
				if _, err := checker.Readable(context.Background(), "token", "owner/repo"); err == nil {
					t.Fatalf("status %d returned no error", status)
				}
			}
			if calls != 2 {
				t.Fatalf("GitHub calls = %d, temporary failure was cached", calls)
			}
		})
	}
}

func TestAccessCheckerMapsUnauthorizedToken(t *testing.T) {
	github := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusUnauthorized)
	}))
	defer github.Close()
	checker := NewAccessChecker(github.Client(), github.URL)
	_, err := checker.Readable(context.Background(), "token", "owner/repo")
	if !errors.Is(err, errBadToken) {
		t.Fatalf("error = %v, want bad token", err)
	}
}

func TestAccessCheckerCoalescesIdenticalMisses(t *testing.T) {
	release := make(chan struct{})
	started := make(chan struct{}, 10)
	var calls atomic.Int32
	github := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		started <- struct{}{}
		<-release
		response.WriteHeader(http.StatusOK)
	}))
	defer github.Close()
	checker := NewAccessChecker(github.Client(), github.URL)
	results := make(chan error, 10)
	for range 10 {
		go func() {
			_, err := checker.Readable(context.Background(), "token", "owner/repo")
			results <- err
		}()
	}
	<-started
	close(release)
	for range 10 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("GitHub calls = %d, want one coalesced call", calls.Load())
	}
}

func TestAccessCheckerGlobalConcurrencyCapFailsFast(t *testing.T) {
	release := make(chan struct{})
	started := make(chan struct{}, accessConcurrency)
	github := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		started <- struct{}{}
		<-release
		response.WriteHeader(http.StatusOK)
	}))
	defer github.Close()
	checker := NewAccessChecker(github.Client(), github.URL)
	results := make(chan error, accessConcurrency)
	for index := range accessConcurrency {
		go func() {
			_, err := checker.Readable(context.Background(), "token", fmt.Sprintf("owner/repo%d", index))
			results <- err
		}()
	}
	for range accessConcurrency {
		<-started
	}
	if _, err := checker.Readable(context.Background(), "token", "owner/overflow"); !errors.Is(err, errAccessBusy) {
		t.Fatalf("overflow error = %v", err)
	}
	close(release)
	for range accessConcurrency {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
}

func TestTicketCapacityIsBounded(t *testing.T) {
	tickets := NewTickets()
	future := time.Now().Add(time.Hour)
	tickets.nextSweep = future
	for index := range maxTickets {
		tickets.sessions[fmt.Sprint(index)] = ticketSession{admissionExpires: future, authExpires: future}
	}
	if _, err := tickets.Issue("principal", []string{"owner/repo"}, future); !errors.Is(err, errTicketCapacity) {
		t.Fatalf("capacity error = %v", err)
	}
}

func TestPrincipalTicketCapReleasesOnConsumeAndSweep(t *testing.T) {
	tickets := NewTickets()
	future := time.Now().Add(time.Hour)
	var first string
	for index := range maxPrincipalTickets {
		ticket, err := tickets.Issue("principal-a", []string{"owner/repo"}, future)
		if err != nil {
			t.Fatal(err)
		}
		if index == 0 {
			first = ticket
		}
	}
	if _, err := tickets.Issue("principal-a", []string{"owner/repo"}, future); !errors.Is(err, errTicketCapacity) {
		t.Fatalf("principal capacity error = %v", err)
	}
	if _, err := tickets.Issue("principal-b", []string{"owner/repo"}, future); err != nil {
		t.Fatalf("another principal was blocked: %v", err)
	}
	if _, ok := tickets.Consume(first); !ok {
		t.Fatal("ticket was not consumed")
	}
	if _, err := tickets.Issue("principal-a", []string{"owner/repo"}, future); err != nil {
		t.Fatalf("consume did not release principal capacity: %v", err)
	}

	swept := NewTickets()
	for range maxPrincipalTickets {
		if _, err := swept.Issue("principal-a", []string{"owner/repo"}, future); err != nil {
			t.Fatal(err)
		}
	}
	swept.mu.Lock()
	for key, session := range swept.sessions {
		session.admissionExpires = time.Now().Add(-time.Second)
		swept.sessions[key] = session
	}
	swept.nextSweep = time.Time{}
	swept.mu.Unlock()
	if _, err := swept.Issue("principal-a", []string{"owner/repo"}, future); err != nil {
		t.Fatalf("expiry sweep did not release principal capacity: %v", err)
	}
}

func TestIdentityCachesAndCoalescesGitHubUser(t *testing.T) {
	release := make(chan struct{})
	started := make(chan struct{}, 10)
	var calls atomic.Int32
	github := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		started <- struct{}{}
		<-release
		response.Write([]byte(`{"id":42,"login":"theo"}`))
	}))
	defer github.Close()
	checker := NewAccessChecker(github.Client(), github.URL)
	results := make(chan error, 10)
	for range 10 {
		go func() {
			identity, expires, err := checker.Identity(context.Background(), "same-token")
			if err == nil && (identity.ID != 42 || identity.Login != "theo" || !expires.After(time.Now())) {
				err = fmt.Errorf("identity = %#v, expires = %v", identity, expires)
			}
			results <- err
		}()
	}
	<-started
	close(release)
	for range 10 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := checker.Identity(context.Background(), "same-token"); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("GitHub calls = %d, want one coalesced and cached call", calls.Load())
	}
}

func TestIdentityLeaderCancellationDoesNotCancelWaiter(t *testing.T) {
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	github := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		close(started)
		<-release
		response.Write([]byte(`{"id":42,"login":"theo"}`))
	}))
	defer github.Close()
	checker := NewAccessChecker(github.Client(), github.URL)
	leaderContext, cancelLeader := context.WithCancel(context.Background())
	leaderResult := make(chan error, 1)
	go func() {
		_, _, err := checker.Identity(leaderContext, "same-token")
		leaderResult <- err
	}()
	<-started

	waiting := make(chan struct{}, 1)
	waiterResult := make(chan error, 1)
	go func() {
		identity, _, err := checker.Identity(observedContext{Context: context.Background(), observed: waiting}, "same-token")
		if err == nil && (identity.ID != 42 || identity.Login != "theo") {
			err = fmt.Errorf("identity = %#v", identity)
		}
		waiterResult <- err
	}()
	<-waiting
	cancelLeader()
	if err := <-leaderResult; !errors.Is(err, context.Canceled) {
		t.Fatalf("leader error = %v, want context canceled", err)
	}
	close(release)
	if err := <-waiterResult; err != nil {
		t.Fatalf("waiter failed after leader cancellation: %v", err)
	}
}

func TestIdentityErrorMapping(t *testing.T) {
	for _, testCase := range []struct {
		name       string
		status     int
		want       error
		httpStatus int
	}{
		{name: "unauthorized", status: http.StatusUnauthorized, want: errBadToken, httpStatus: http.StatusUnauthorized},
		{name: "rate limited", status: http.StatusTooManyRequests, httpStatus: http.StatusServiceUnavailable},
		{name: "transient", status: http.StatusInternalServerError, httpStatus: http.StatusServiceUnavailable},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			github := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				response.WriteHeader(testCase.status)
			}))
			defer github.Close()
			checker := NewAccessChecker(github.Client(), github.URL)
			_, _, err := checker.Identity(context.Background(), "token")
			if err == nil {
				t.Fatal("identity unexpectedly succeeded")
			}
			if testCase.want != nil && !errors.Is(err, testCase.want) {
				t.Fatalf("error = %v, want %v", err, testCase.want)
			}
			if got := accessStatus(err); got != testCase.httpStatus {
				t.Fatalf("HTTP status = %d, want %d", got, testCase.httpStatus)
			}
		})
	}
}

func TestIdentitySharesAccessAdmissionLimit(t *testing.T) {
	checker := NewAccessChecker(nil, "https://api.github.invalid")
	for range accessConcurrency {
		checker.semaphore <- struct{}{}
	}
	defer func() {
		for range accessConcurrency {
			<-checker.semaphore
		}
	}()
	_, _, err := checker.Identity(context.Background(), "token")
	if !errors.Is(err, errAccessBusy) || accessStatus(err) != http.StatusServiceUnavailable {
		t.Fatalf("error = %v, status = %d", err, accessStatus(err))
	}
}
