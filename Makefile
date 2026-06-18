.DEFAULT_GOAL := help
SHELL := /bin/bash

ROOT := $(shell pwd)
BRIDGE_HEARTBEAT := $(ROOT)/state/bridge.alive

# launchd label for the daemon. Override to keep an existing install, e.g.
#   make LAUNCH_LABEL=com.you.teamplus start
LAUNCH_LABEL ?= com.teamplus.daemon
LAUNCH_PLIST := $(HOME)/Library/LaunchAgents/$(LAUNCH_LABEL).plist
LAUNCH_DOMAIN := gui/$(shell id -u)
LAUNCH_TARGET := $(LAUNCH_DOMAIN)/$(LAUNCH_LABEL)

.PHONY: help claude daemon kill-daemon refresh setup-creds setup-tg typecheck status \
        start stop restart logs install-launchd uninstall-launchd

help:  ## Show available targets
	@awk 'BEGIN{FS=":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  \033[1m%-16s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

claude:  ## Launch Claude Code with bridge MCP + remote-control + skip-permissions
	@if ! pgrep -f "channel/server.ts" > /dev/null; then \
	  echo "⚠ daemon (channel/server.ts) is not running — buttons in Telegram won't work."; \
	  echo "  Start it with: make start  (launchd-managed; survives shell exit)"; \
	  echo "  Or foreground:  make daemon"; \
	  echo; \
	fi
	@echo "→ launching claude with bridge channel + remote-control + skip-permissions"
	claude \
	  --remote-control \
	  --dangerously-load-development-channels server:bridge \
	  --dangerously-skip-permissions

daemon:  ## Start the long-running TeamPlus → Telegram daemon (foreground)
	@./run.sh

kill-daemon:  ## Stop any running daemon
	@pgrep -f "channel/server.ts" > /dev/null && pkill -f "channel/server.ts" && echo "✓ daemon stopped" || echo "(no daemon running)"

refresh:  ## Refresh TeamPlus cookies via patchright auto-login
	@./scripts/refresh.sh

setup-creds:  ## Interactive prompt for TeamPlus account/password → .env
	@./scripts/setup_creds.sh

setup-tg:  ## Interactive prompt for Telegram bot token → .telegram.json (chat_id locked)
	@./scripts/setup_telegram.sh

typecheck:  ## Type-check the channel/ project
	@cd channel && bunx tsc --noEmit && echo "✓ type-check clean"

status:  ## Show daemon pid + bridge heartbeat + launchd state
	@pgrep -lf "channel/server.ts" || echo "(no daemon running)"
	@if [ -f $(BRIDGE_HEARTBEAT) ]; then \
	  age=$$(( $$(date +%s) - $$(stat -f %m $(BRIDGE_HEARTBEAT)) )); \
	  if [ $$age -lt 15 ]; then echo "🟢 bridge alive ($${age}s ago)"; \
	  else echo "🟡 bridge heartbeat stale ($${age}s ago)"; fi; \
	else echo "⚫ no bridge heartbeat (Claude not running with --dangerously-load-development-channels server:bridge)"; \
	fi
	@if launchctl print $(LAUNCH_TARGET) >/dev/null 2>&1; then \
	  launchctl print $(LAUNCH_TARGET) | awk '/state =|^\tpid =|last exit code/ {print "  launchd "$$0}'; \
	else echo "⚫ launchd job not loaded (run: make start)"; \
	fi

start:  ## Start daemon under launchd (auto-respawn, survives shell exit)
	@if [ ! -f $(LAUNCH_PLIST) ]; then \
	  echo "✗ plist missing at $(LAUNCH_PLIST) — run: make install-launchd"; exit 1; \
	fi
	@if launchctl print $(LAUNCH_TARGET) >/dev/null 2>&1; then \
	  launchctl kickstart $(LAUNCH_TARGET) >/dev/null && echo "✓ already loaded — kicked"; \
	else \
	  launchctl bootstrap $(LAUNCH_DOMAIN) $(LAUNCH_PLIST) && echo "✓ bootstrapped"; \
	fi

stop:  ## Stop daemon (launchd unloads, no respawn until 'make start')
	@launchctl bootout $(LAUNCH_TARGET) 2>/dev/null && echo "✓ stopped" || echo "(not loaded)"

restart:  ## Force-restart launchd-managed daemon (kickstart -k)
	@launchctl kickstart -k $(LAUNCH_TARGET) >/dev/null 2>&1 && echo "✓ restarted" || echo "✗ not loaded — run: make start"

logs:  ## Tail logs/server.log (Ctrl-C to exit)
	@tail -f logs/server.log

install-launchd:  ## Install LaunchAgent plist (one-time setup, then 'make start')
	@if [ -f $(LAUNCH_PLIST) ]; then \
	  echo "(plist already at $(LAUNCH_PLIST))"; \
	else \
	  mkdir -p $(HOME)/Library/LaunchAgents; \
	  printf '%s\n' \
	    '<?xml version="1.0" encoding="UTF-8"?>' \
	    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
	    '<plist version="1.0">' \
	    '<dict>' \
	    '    <key>Label</key><string>$(LAUNCH_LABEL)</string>' \
	    '    <key>ProgramArguments</key><array><string>$(ROOT)/run.sh</string></array>' \
	    '    <key>WorkingDirectory</key><string>$(ROOT)</string>' \
	    '    <key>RunAtLoad</key><true/>' \
	    '    <key>KeepAlive</key><true/>' \
	    '    <key>ThrottleInterval</key><integer>10</integer>' \
	    '    <key>StandardOutPath</key><string>$(ROOT)/logs/server.log</string>' \
	    '    <key>StandardErrorPath</key><string>$(ROOT)/logs/server.log</string>' \
	    '    <key>EnvironmentVariables</key><dict>' \
	    '        <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>' \
	    '    </dict>' \
	    '</dict>' \
	    '</plist>' > $(LAUNCH_PLIST); \
	  echo "✓ wrote $(LAUNCH_PLIST)"; \
	fi
	@echo "→ run: make start"

uninstall-launchd:  ## Bootout + delete LaunchAgent plist
	@launchctl bootout $(LAUNCH_TARGET) 2>/dev/null || true
	@rm -f $(LAUNCH_PLIST) && echo "✓ uninstalled" || true
