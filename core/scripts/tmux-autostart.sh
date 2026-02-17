#!/bin/bash

# tmux Auto-Start Installer
# Configures tmux to launch automatically on new terminal sessions
# with the status bar hidden for a clean terminal experience.
#
# Usage:
#   ./scripts/tmux-autostart.sh install    # Enable tmux auto-start
#   ./scripts/tmux-autostart.sh uninstall  # Remove tmux auto-start
#   ./scripts/tmux-autostart.sh status     # Check current state

set -euo pipefail

BASHRC="$HOME/.bashrc"
TMUX_CONF="$HOME/.tmux.conf"
MARKER_START="# Auto-start tmux (hidden status bar"
MARKER_END="fi"

TMUX_BLOCK='# Auto-start tmux (hidden status bar, always new session per terminal)
if command -v tmux &> /dev/null && [ -z "$TMUX" ]; then
    _tsbase="$(basename "$PWD" | tr ".:" "_")"
    # Always create a new session — append incrementing suffix if name taken
    _tsname="$_tsbase"
    _tsi=1
    while tmux has-session -t "=$_tsname" 2>/dev/null; do
        _tsname="${_tsbase}-${_tsi}"
        _tsi=$((_tsi + 1))
    done
    tmux new-session -s "$_tsname"
    unset _tsbase _tsname _tsi
fi'

TYPING_EXIT_SCRIPT="$HOME/.tmux-typing-exits-copy.sh"

# Lines managed in ~/.tmux.conf (order matters)
TMUX_CONF_CONTENT='# Hide the status bar
set -g status off

# Enable mouse support
set -g mouse on

# Pre-declare terminal features so tmux does not probe with DA queries
# (Prevents xterm.js DA2 responses like [>0;276;0c leaking into pane input)
set -s terminal-features[0] "xterm*:256:clipboard:ccolour:cstyle:focus:mouse:overline:rectfill:RGB:strikethrough:title:usstyle"
set -s terminal-features[1] "screen*:title"

# Low escape-time to reduce the window for DA response leaking (default 500 is far too high)
set -sg escape-time 25

# Scroll up enters copy mode with -e (auto-exits when you scroll back to bottom)
bind -n WheelUpPane if-shell -Ft= '"'"'#{mouse_any_flag}'"'"' '"'"'send-keys -M'"'"' '"'"'if -Ft= "#{pane_in_mode}" "send-keys -M" "copy-mode -e; send-keys -M"'"'"'

# Any typing key exits copy mode and passes through to the app
run-shell "bash ~/.tmux-typing-exits-copy.sh"

# Disable tmux right-click menu — let terminal handle copy/paste natively
unbind -n MouseDown3Pane
unbind -n M-MouseDown3Pane
unbind -n MouseDown3Status
unbind -n MouseDown3StatusLeft
unbind -n MouseDown3StatusRight

# Increase scrollback buffer
set -g history-limit 1000000'

usage() {
    echo "Usage: $0 {install|uninstall|status}"
    echo
    echo "Commands:"
    echo "  install    Add tmux auto-start to ~/.bashrc and hide status bar in ~/.tmux.conf"
    echo "  uninstall  Remove tmux auto-start from ~/.bashrc and status-off from ~/.tmux.conf"
    echo "  status     Show whether tmux auto-start is currently configured"
    exit 1
}

has_bashrc_block() {
    grep -qF "$MARKER_START" "$BASHRC" 2>/dev/null
}

has_tmux_conf_entry() {
    grep -qE "^set -g status (on|off)" "$TMUX_CONF" 2>/dev/null
}

install() {
    local changed=false

    # --- ~/.tmux.conf ---
    if has_tmux_conf_entry && grep -qF "unbind -n MouseDown3Pane" "$TMUX_CONF" 2>/dev/null && grep -qF "terminal-features" "$TMUX_CONF" 2>/dev/null; then
        echo "[tmux.conf] Already fully configured — skipping"
    else
        printf '%s\n' "$TMUX_CONF_CONTENT" > "$TMUX_CONF"
        echo "[tmux.conf] Written full config (status off, mouse scroll, right-click passthrough, terminal-features, scrollback 1M)"
        changed=true
    fi

    # --- ~/.bashrc ---
    if has_bashrc_block; then
        if grep -qF "always new session per terminal" "$BASHRC" 2>/dev/null; then
            echo "[bashrc]    Already has new-session-per-terminal block — skipping"
        else
            # Upgrade legacy block to new-session-per-terminal block
            sed -i "/^${MARKER_START}/,/^${MARKER_END}$/d" "$BASHRC"
            # Clean up trailing blank lines
            sed -i -e :a -e '/^\n*$/{$d;N;ba' -e '}' "$BASHRC"
            printf '\n%s\n' "$TMUX_BLOCK" >> "$BASHRC"
            echo "[bashrc]    Upgraded tmux auto-start block (new session per terminal)"
            changed=true
        fi
    else
        printf '\n%s\n' "$TMUX_BLOCK" >> "$BASHRC"
        echo "[bashrc]    Added tmux auto-start block (new session per terminal)"
        changed=true
    fi

    # --- Reload tmux config if running ---
    if [ "$changed" = true ] && [ -n "${TMUX:-}" ]; then
        tmux source-file "$TMUX_CONF" 2>/dev/null && echo "[tmux]      Reloaded config" || true
    fi

    echo
    echo "Done. New terminal sessions will auto-start tmux (no status bar, mouse scroll, right-click passthrough, new session per terminal)."
}

uninstall() {
    local changed=false

    # --- ~/.tmux.conf ---
    if has_tmux_conf_entry; then
        rm -f "$TMUX_CONF"
        echo "[tmux.conf] Removed tmux config"
        changed=true
    else
        echo "[tmux.conf] No tmux config found — skipping"
    fi

    # --- ~/.bashrc ---
    if has_bashrc_block; then
        # Remove the block (marker line through closing fi)
        sed -i "/^${MARKER_START}$/,/^${MARKER_END}$/d" "$BASHRC"
        # Clean up trailing blank lines
        sed -i -e :a -e '/^\n*$/{$d;N;ba' -e '}' "$BASHRC"
        echo "[bashrc]    Removed tmux auto-start block"
        changed=true
    else
        echo "[bashrc]    No tmux auto-start block found — skipping"
    fi

    echo
    if [ "$changed" = true ]; then
        echo "Done. tmux auto-start has been removed."
    else
        echo "Nothing to uninstall."
    fi
}

status() {
    echo "tmux auto-start status:"
    echo

    if has_tmux_conf_entry; then
        echo "  ~/.tmux.conf   : configured (mouse scroll, right-click passthrough, scrollback 1M)"
    else
        echo "  ~/.tmux.conf   : not configured (defaults)"
    fi

    if has_bashrc_block; then
        if grep -qF "always new session per terminal" "$BASHRC" 2>/dev/null; then
            echo "  ~/.bashrc      : auto-start ENABLED (new session per terminal)"
        else
            echo "  ~/.bashrc      : auto-start ENABLED (legacy — run install to upgrade)"
        fi
    else
        echo "  ~/.bashrc      : auto-start disabled"
    fi

    echo

    if command -v tmux &> /dev/null; then
        echo "  tmux installed : yes ($(tmux -V))"
    else
        echo "  tmux installed : NO — install with: sudo apt install tmux"
    fi

    if [ -n "${TMUX:-}" ]; then
        echo "  tmux session   : active ($(tmux display-message -p '#S'))"
    else
        echo "  tmux session   : not in tmux"
    fi
}

case "${1:-}" in
    install)   install ;;
    uninstall) uninstall ;;
    status)    status ;;
    *)         usage ;;
esac
