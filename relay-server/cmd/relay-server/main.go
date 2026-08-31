package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/theolundqvist/pr-cockpit/relay-server/internal/relay"
)

func main() {
	healthcheck := flag.Bool("healthcheck", false, "check the local relay health endpoint")
	flag.Parse()
	address := envOr("RELAY_ADDR", ":4821")
	if *healthcheck {
		if err := checkHealth(address); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if err := run(address); err != nil {
		slog.Error("relay stopped", "error", err)
		os.Exit(1)
	}
}

func run(address string) error {
	secret := os.Getenv("WEBHOOK_SECRET")
	if secret == "" {
		return errors.New("WEBHOOK_SECRET is required")
	}
	retention, err := time.ParseDuration(envOr("RELAY_RETENTION", "168h"))
	if err != nil || retention <= 0 {
		return errors.New("RELAY_RETENTION must be a positive Go duration")
	}
	store, err := relay.OpenStore(envOr("RELAY_DB_PATH", "/data/relay.db"), retention)
	if err != nil {
		return fmt.Errorf("open relay store: %w", err)
	}
	defer store.Close()
	server, err := relay.NewServer(store, relay.Config{
		WebhookSecret:     secret,
		GitHubAPIURL:      envOr("GITHUB_API_URL", "https://api.github.com"),
		ForwardWebhookURL: os.Getenv("RELAY_FORWARD_WEBHOOK_URL"),
		Logger:            slog.Default(),
	})
	if err != nil {
		return err
	}
	httpServer := &http.Server{
		Addr: address, Handler: server.Handler(),
		ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 15 * time.Second,
		MaxHeaderBytes: 1 << 20,
	}
	adminAddress := envOr("RELAY_ADMIN_ADDR", "127.0.0.1:4822")
	adminServer := &http.Server{
		Addr: adminAddress, Handler: server.AdminHandler(),
		ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 15 * time.Second,
		MaxHeaderBytes: 1 << 20,
	}
	publicListener, err := net.Listen("tcp", address)
	if err != nil {
		return fmt.Errorf("listen on relay address: %w", err)
	}
	adminListener, err := net.Listen("tcp", adminAddress)
	if err != nil {
		publicListener.Close()
		return fmt.Errorf("listen on admin address: %w", err)
	}
	stopping := make(chan os.Signal, 1)
	signal.Notify(stopping, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(stopping)
	errs := make(chan error, 2)
	go func() { errs <- httpServer.Serve(publicListener) }()
	go func() { errs <- adminServer.Serve(adminListener) }()
	slog.Info("relay listening", "address", address, "adminAddress", adminAddress)

	var serveErr error
	serveResults := 0
	select {
	case <-stopping:
	case result := <-errs:
		serveErr = normalizeServeError(result)
		serveResults = 1
	}
	server.Shutdown()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	shutdownErr := errors.Join(httpServer.Shutdown(ctx), adminServer.Shutdown(ctx))
	if shutdownErr != nil {
		shutdownErr = errors.Join(shutdownErr, httpServer.Close(), adminServer.Close())
	}
	for serveResults < 2 {
		result := <-errs
		serveErr = errors.Join(serveErr, normalizeServeError(result))
		serveResults++
	}
	return errors.Join(serveErr, shutdownErr)
}

func normalizeServeError(err error) error {
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func checkHealth(address string) error {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("invalid RELAY_ADDR: %w", err)
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	client := &http.Client{Timeout: 3 * time.Second}
	response, err := client.Get("http://" + host + ":" + port + "/health")
	if err != nil {
		return err
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("health returned %s", response.Status)
	}
	return nil
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
