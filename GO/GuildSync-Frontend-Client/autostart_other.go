//go:build !windows && !darwin && !linux

package main

func startAtLoginSupported() bool { return false }

func startAtLoginActive() bool { return false }

func setStartAtLogin(bool) error { return nil }

func setStartAtLoginFor(string) error { return nil }

func refreshStartAtLoginFor(string) error { return nil }
