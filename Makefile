PLUGIN_DIR    := com.narlei.ticktickfocus.ulanziPlugin
INSTALL_BASE  := $(HOME)/Library/Application Support/Ulanzi/UlanziDeck/Plugins
INSTALL_DIR   := $(INSTALL_BASE)/$(PLUGIN_DIR)
DIST_DIR      := dist
ZIP           := $(DIST_DIR)/$(PLUGIN_DIR).zip

NATIVE_SRC    := native/ticktick-login.swift
LOGIN_BIN     := $(PLUGIN_DIR)/resources/ticktick-login

APP_NAME      := Ulanzi Studio

.PHONY: help package install restart clean sync login-bin bump_major bump_minor bump_patch

help:
	@echo "Available targets:"
	@echo "  make package     - Build a distributable ZIP at $(ZIP)"
	@echo "  make install     - Sync plugin + restart $(APP_NAME)"
	@echo "  make restart     - Restart $(APP_NAME) only"
	@echo "  make clean       - Remove $(DIST_DIR)/"
	@echo "  make bump_major  - Bump major version (1.0.0 → 2.0.0)"
	@echo "  make bump_minor  - Bump minor version (1.0.0 → 1.1.0)"
	@echo "  make bump_patch  - Bump patch version (1.0.0 → 1.0.1)"

bump_major bump_minor bump_patch:
	@TYPE=$(subst bump_,,$@); \
	cd $(PLUGIN_DIR) && npm version $$TYPE --no-git-tag-version --silent; \
	NEW_VER=$$(node -p "require('./package.json').version"); \
	node -e " \
		const fs = require('fs'); \
		const f = 'manifest.json'; \
		const m = JSON.parse(fs.readFileSync(f)); \
		m.Version = '$$NEW_VER'; \
		fs.writeFileSync(f, JSON.stringify(m, null, 2) + '\n'); \
	"; \
	echo "✓ Version bumped to $$NEW_VER (package.json + manifest.json)"

login-bin:
	@echo "→ Compiling native login helper (universal arm64+x86_64)..."
	@swiftc -O -target arm64-apple-macos11 $(NATIVE_SRC) -o /tmp/ttlogin-arm64
	@swiftc -O -target x86_64-apple-macos10.15 $(NATIVE_SRC) -o /tmp/ttlogin-x86
	@lipo -create /tmp/ttlogin-arm64 /tmp/ttlogin-x86 -output $(LOGIN_BIN)
	@chmod +x $(LOGIN_BIN)
	@rm -f /tmp/ttlogin-arm64 /tmp/ttlogin-x86
	@xattr -dr com.apple.quarantine $(LOGIN_BIN) 2>/dev/null || true
	@echo "✓ Built $(LOGIN_BIN)"

package: clean login-bin
	@echo "→ Reinstalling production deps in $(PLUGIN_DIR)..."
	@rm -rf $(PLUGIN_DIR)/node_modules
	@cd $(PLUGIN_DIR) && npm install --omit=dev --silent
	@echo "→ Pruning junk files..."
	@find $(PLUGIN_DIR) -name ".DS_Store" -delete
	@echo "→ Building $(ZIP)..."
	@mkdir -p $(DIST_DIR)
	@zip -r -q $(ZIP) $(PLUGIN_DIR) -x "*.log" -x "*/.git/*"
	@echo "✓ $(ZIP) ($$(du -h $(ZIP) | cut -f1))"

install: login-bin sync restart
	@echo "✓ Installed and restarted."

sync:
	@if [ ! -d $(PLUGIN_DIR)/node_modules ]; then \
		echo "→ Installing deps..."; \
		cd $(PLUGIN_DIR) && npm install --omit=dev --silent; \
	fi
	@echo "→ Syncing to $(INSTALL_DIR)..."
	@mkdir -p "$(INSTALL_BASE)"
	@rsync -a --delete \
		--exclude=".DS_Store" \
		--exclude="*.log" \
		--exclude=".git" \
		$(PLUGIN_DIR)/ "$(INSTALL_DIR)/"
	@echo "→ De-quarantining native helper..."
	@xattr -dr com.apple.quarantine "$(INSTALL_DIR)/resources/ticktick-login" 2>/dev/null || true

APP_PROC      := /Applications/$(APP_NAME).app/

restart:
	@echo "→ Restarting $(APP_NAME)..."
	@osascript -e 'tell application "$(APP_NAME)" to quit' >/dev/null 2>&1 || true
	@for i in 1 2 3 4 5; do \
		pgrep -f "$(APP_PROC)" >/dev/null 2>&1 || break; \
		sleep 1; \
	done
	@pkill -f "$(APP_PROC)" >/dev/null 2>&1 || true
	@sleep 1
	@open -a "$(APP_NAME)"

clean:
	@rm -rf $(DIST_DIR)
