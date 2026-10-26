// The helper loads Gitleaks once and accepts bounded, authenticated loopback
// requests. Inputs and findings are never written to disk or application logs.
package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"github.com/rs/zerolog"
	"github.com/zricethezav/gitleaks/v8/detect"
)

const protocol = 1
const scannerVersion = "8.30.1"
const maxText = 1024 * 1024

type boot struct {
	Token       string `json:"token"`
	IdleSeconds int    `json:"idle_seconds"`
}

type finding struct {
	Secret string
	RuleID string
}

func main() {
	if err := serve(); err != nil {
		os.Exit(1)
	}
}

func serve() error {
	zerolog.SetGlobalLevel(zerolog.Disabled)
	var cfg boot
	if err := json.NewDecoder(io.LimitReader(os.Stdin, 4096)).Decode(&cfg); err != nil {
		return err
	}
	key, err := hex.DecodeString(cfg.Token)
	if err != nil || len(key) != 32 {
		return io.ErrUnexpectedEOF
	}
	if cfg.IdleSeconds < 1 || cfg.IdleSeconds > 300 {
		cfg.IdleSeconds = 300
	}
	detector, err := detect.NewDetectorDefaultConfig()
	if err != nil {
		return err
	}
	detector.IgnoreGitleaksAllow = true
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer listener.Close()
	var last atomic.Int64
	last.Store(time.Now().UnixNano())
	serial := make(chan struct{}, 1)
	server := &http.Server{ReadHeaderTimeout: time.Second, ReadTimeout: 4 * time.Second, WriteTimeout: 4 * time.Second, IdleTimeout: 5 * time.Second, MaxHeaderBytes: 4096, ErrorLog: log.New(io.Discard, "", 0)}
	server.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.Host != listener.Addr().String() || r.Header.Get("Origin") != "" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if r.Method == "GET" && r.URL.Path == "/health" {
			challenge := r.URL.Query().Get("challenge")
			if len(challenge) != 64 {
				http.Error(w, "invalid challenge", 400)
				return
			}
			mac := hmac.New(sha256.New, key)
			mac.Write([]byte(challenge))
			json.NewEncoder(w).Encode(map[string]any{"protocol": protocol, "version": scannerVersion, "proof": hex.EncodeToString(mac.Sum(nil))})
			return
		}
		// Prove server identity before the client discloses its token or input.
		// Unauthenticated probes do not extend the helper's idle lifetime.
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+cfg.Token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		last.Store(time.Now().UnixNano())
		if r.Method == "POST" && r.URL.Path == "/shutdown" {
			w.Write([]byte(`{}`))
			go server.Close()
			return
		}
		if r.Method != "POST" || r.URL.Path != "/scan" {
			http.Error(w, "not found", 404)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		select {
		case serial <- struct{}{}:
			defer func() { <-serial }()
		case <-ctx.Done():
			http.Error(w, "scanner busy", 503)
			return
		}
		var input struct {
			Text string `json:"text"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2*maxText))
		if decoder.Decode(&input) != nil || len(input.Text) > maxText {
			http.Error(w, "invalid input", 400)
			return
		}
		var extra any
		if decoder.Decode(&extra) != io.EOF {
			http.Error(w, "invalid input", 400)
			return
		}
		results := detector.DetectContext(ctx, detect.Fragment{Raw: input.Text})
		if ctx.Err() != nil {
			http.Error(w, "scan timeout", 503)
			return
		}
		if len(results) > 2048 {
			http.Error(w, "too many findings", 413)
			return
		}
		findings := make([]finding, 0, len(results))
		responseBytes := 0
		for _, result := range results {
			responseBytes += len(result.Secret) + len(result.RuleID)
			if responseBytes > maxText {
				http.Error(w, "too many findings", 413)
				return
			}
			findings = append(findings, finding{Secret: result.Secret, RuleID: result.RuleID})
		}
		// DetectContext returns per-call findings; do not use AddFinding, which
		// would retain credentials in the persistent detector across requests.
		json.NewEncoder(w).Encode(findings)
	})
	done := make(chan struct{})
	defer close(done)
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				if time.Since(time.Unix(0, last.Load())) >= time.Duration(cfg.IdleSeconds)*time.Second {
					server.Close()
					return
				}
			}
		}
	}()
	if err := json.NewEncoder(os.Stdout).Encode(map[string]any{"port": listener.Addr().(*net.TCPAddr).Port, "pid": os.Getpid(), "protocol": protocol, "version": scannerVersion}); err != nil {
		return err
	}
	err = server.Serve(listener)
	if err == http.ErrServerClosed || (err != nil && strings.Contains(err.Error(), "closed network connection")) {
		return nil
	}
	return err
}
