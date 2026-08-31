package main

import (
	"errors"
	"net/http"
	"testing"
)

func TestServeErrorsAreNormalizedBeforeJoining(t *testing.T) {
	listenerFailure := errors.New("listener failed")
	combined := errors.Join(normalizeServeError(listenerFailure), normalizeServeError(http.ErrServerClosed))
	if !errors.Is(combined, listenerFailure) {
		t.Fatalf("combined error = %v, want listener failure", combined)
	}
	if errors.Is(combined, http.ErrServerClosed) {
		t.Fatalf("combined error = %v, peer shutdown masked listener failure", combined)
	}
}
