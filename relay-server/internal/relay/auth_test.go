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
