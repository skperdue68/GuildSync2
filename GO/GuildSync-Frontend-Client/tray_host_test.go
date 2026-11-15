package main

import (
	"context"
	"testing"
	"time"
)

func TestTrayHostLossRestoresAccessAcrossPanelRestarts(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	states := []bool{true, false, false, true, false}
	checks, restored := 0, 0
	monitorTrayHost(ctx, time.Millisecond, func(context.Context) bool {
		state := states[min(checks, len(states)-1)]
		checks++
		return state
	}, func() {
		restored++
		if restored == 2 {
			cancel()
		}
	})
	if restored != 2 || checks != len(states) {
		t.Fatalf("wanted one restore per panel loss, got %d restores in %d checks", restored, checks)
	}
}

func TestTrayHostMonitorStopsAtShutdown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	monitorTrayHost(ctx, time.Millisecond, func(context.Context) bool { return false }, func() {
		t.Fatal("shutdown reopened the window")
	})
}
