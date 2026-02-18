#!/bin/bash
# LM-Assist Services Manager
# Manage Core API and Web services

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color

# Project root directory (relative to script location)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR"

# Load environment configuration from .env if it exists
ENV_FILE="$PROJECT_ROOT/.env"
if [ -f "$ENV_FILE" ]; then
    set -a
    source <(grep -v '^\s*#' "$ENV_FILE" | grep -v '^\s*$' | grep '=')
    set +a
fi

# Detect host IP address
HOST_IP=$(hostname -I | awk '{print $1}')
if [ -z "$HOST_IP" ]; then
    HOST_IP="localhost"
fi

# Worktree-aware variable initialization
# If WORKTREE_NUMBER is set (via .env or environment), apply port offsets and file suffixes
WT_NUM="${WORKTREE_NUMBER:-}"
if [ -n "$WT_NUM" ]; then
    WT_SUFFIX="-wt-${WT_NUM}"
    WT_PORT_OFFSET="$WT_NUM"
else
    WT_SUFFIX=""
    WT_PORT_OFFSET=0
fi

# Ports (can be overridden via .env, offset by worktree number)
API_PORT="${API_PORT:-$((3100 + WT_PORT_OFFSET))}"
WEB_PORT="${WEB_PORT:-$((3848 + WT_PORT_OFFSET))}"

# Project paths
CORE_DIR="$PROJECT_ROOT/core"
WEB_DIR="$PROJECT_ROOT/web"

# PID files for tracking server processes
CORE_PID_FILE="$CORE_DIR/server.pid"
WEB_PID_FILE="$WEB_DIR/web.pid"

# Log files
CORE_LOG="$CORE_DIR/server.log"
WEB_LOG="$WEB_DIR/web.log"
BUILD_LOG="/tmp/lm-assist-build${WT_SUFFIX}.log"

# ============================================================================
# Utility Functions
# ============================================================================

# Function to show header
show_header() {
    clear
    echo -e "${CYAN}=============================================================${NC}"
    echo -e "${CYAN}||${NC}        ${MAGENTA}LM-Assist Services Manager${NC}                      ${CYAN}||${NC}"
    echo -e "${CYAN}||${NC}        ${BLUE}Core API + Web${NC}                                  ${CYAN}||${NC}"
    echo -e "${CYAN}=============================================================${NC}"
    echo ""
}

# Function to check prerequisites
check_prerequisites() {
    local missing_deps=()
    local all_good=true

    if ! command -v node &> /dev/null; then
        missing_deps+=("node")
        all_good=false
    fi

    if ! command -v npm &> /dev/null; then
        missing_deps+=("npm")
        all_good=false
    fi

    if ! command -v curl &> /dev/null; then
        missing_deps+=("curl")
        all_good=false
    fi

    if ! command -v jq &> /dev/null; then
        missing_deps+=("jq")
        all_good=false
    fi

    if ! command -v lsof &> /dev/null; then
        missing_deps+=("lsof")
        all_good=false
    fi

    if [ "$all_good" = false ]; then
        echo -e "${RED}---------------------------------------------------${NC}"
        echo -e "${RED}  MISSING REQUIRED DEPENDENCIES${NC}"
        echo -e "${RED}---------------------------------------------------${NC}"
        echo ""
        for dep in "${missing_deps[@]}"; do
            echo -e "  ${RED}x${NC} $dep"
        done
        echo ""
        return 1
    fi

    return 0
}

# Function to check if a port is in use (supports both IPv4 and IPv6)
check_port() {
    local port=$1
    # Check using lsof (both IPv4 and IPv6)
    if lsof -i ":$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
        return 0
    fi
    # Fallback: check using ss
    if ss -tlnp 2>/dev/null | grep -q ":$port "; then
        return 0
    fi
    return 1
}

# Function to check if a port is responding to HTTP requests
check_port_responding() {
    local port=$1
    local timeout=${2:-5}
    local response=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$timeout" "http://localhost:$port" 2>/dev/null || echo "000")
    [[ "$response" != "000" ]]
    return $?
}

# Function to kill process tree (parent and all children)
kill_process_tree() {
    local pid=$1
    local signal=${2:-TERM}

    # Get all child processes
    local children=$(pgrep -P "$pid" 2>/dev/null)

    # Kill children first
    for child in $children; do
        kill_process_tree "$child" "$signal"
    done

    # Kill the parent
    kill -"$signal" "$pid" 2>/dev/null
}

# Function to check if API server is healthy
check_api_health() {
    local response=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$API_PORT/health" 2>/dev/null || echo "000")
    [[ "$response" == "200" ]]
    return $?
}

# Function to get process PID from file or port
get_process_pid() {
    local pid_file=$1
    local port=$2

    if [ -f "$pid_file" ]; then
        local pid=$(cat "$pid_file")
        if kill -0 "$pid" 2>/dev/null; then
            echo "$pid"
            return 0
        fi
    fi
    # Fallback: find by port
    lsof -i ":$port" -sTCP:LISTEN -t 2>/dev/null | head -1
}

# Function to check if hub is configured via .env
is_hub_configured() {
    [ -n "${TIER_AGENT_API_KEY:-}" ] && [ -n "${TIER_AGENT_HUB_URL:-}" ]
}

# ============================================================================
# Build Functions
# ============================================================================

# Function to check build status
check_build_status() {
    if [ -d "$CORE_DIR/dist" ]; then
        local src_time=$(find "$CORE_DIR/src" -name "*.ts" -newer "$CORE_DIR/dist" 2>/dev/null | head -1)

        if [ -z "$src_time" ]; then
            echo "up-to-date"
        else
            echo "outdated"
        fi
    else
        echo "not-built"
    fi
}

# Function to build project
build_project() {
    echo -e "${BLUE}Building core...${NC}"

    # Check if node_modules exists (workspace hoists to root)
    if [ ! -d "$PROJECT_ROOT/node_modules" ]; then
        echo -e "${YELLOW}Installing dependencies...${NC}"
        cd "$PROJECT_ROOT"
        npm install > "$BUILD_LOG" 2>&1
        if [ $? -ne 0 ]; then
            echo -e "${RED}npm install failed. Check $BUILD_LOG${NC}"
            return 1
        fi
    fi

    # Build
    cd "$CORE_DIR"
    echo -e "${BLUE}Compiling TypeScript...${NC}"
    npm run build >> "$BUILD_LOG" 2>&1
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}Build successful${NC}"
        return 0
    else
        echo -e "${RED}Build failed. Check $BUILD_LOG${NC}"
        return 1
    fi
}

# Function to check web build status
check_web_build_status() {
    if [ -d "$WEB_DIR/.next" ]; then
        local src_time=$(find "$WEB_DIR/src" -name "*.ts" -o -name "*.tsx" -o -name "*.css" 2>/dev/null | xargs -r stat -c '%Y' 2>/dev/null | sort -rn | head -1)
        local build_time=$(stat -c '%Y' "$WEB_DIR/.next" 2>/dev/null || echo "0")

        if [ -n "$src_time" ] && [ "$src_time" -gt "$build_time" ]; then
            echo "outdated"
        else
            echo "up-to-date"
        fi
    else
        echo "not-built"
    fi
}

# Function to build web (Next.js)
build_web() {
    echo -e "${BLUE}Building web...${NC}"

    # Check if node_modules exists (workspace hoists to root)
    if [ ! -d "$PROJECT_ROOT/node_modules" ]; then
        echo -e "${YELLOW}Installing dependencies...${NC}"
        cd "$PROJECT_ROOT"
        npm install > "$BUILD_LOG" 2>&1
        if [ $? -ne 0 ]; then
            echo -e "${RED}npm install failed. Check $BUILD_LOG${NC}"
            return 1
        fi
    fi

    cd "$WEB_DIR"
    echo -e "${BLUE}Running next build...${NC}"
    npx next build >> "$BUILD_LOG" 2>&1
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}Web build successful${NC}"
        return 0
    else
        echo -e "${RED}Web build failed. Check $BUILD_LOG${NC}"
        return 1
    fi
}

# Function to clean and rebuild
clean_build() {
    echo -e "${BLUE}Cleaning build artifacts...${NC}"
    rm -rf "$CORE_DIR/dist/"
    rm -rf "$PROJECT_ROOT/node_modules/"
    echo -e "${GREEN}Cleaned${NC}"
    build_project
}

# ============================================================================
# Core API Server Functions
# ============================================================================

# Function to start Core API server
start_core() {
    echo -e "${BLUE}Starting Core API Server...${NC}"

    if check_port $API_PORT; then
        echo -e "${YELLOW}Core API is already running on port $API_PORT${NC}"
        return 0
    fi

    # Check build status
    local build_status=$(check_build_status)
    if [ "$build_status" = "not-built" ] || [ "$build_status" = "outdated" ]; then
        echo -e "${YELLOW}Build is $build_status. Building first...${NC}"
        build_project
        if [ $? -ne 0 ]; then
            return 1
        fi
    fi

    cd "$CORE_DIR"

    # Start the server with environment variables preserved
    local env_vars=""
    if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
        env_vars="$env_vars ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"
    fi
    if [ -n "${TIER_AGENT_HUB_URL:-}" ]; then
        env_vars="$env_vars TIER_AGENT_HUB_URL=$TIER_AGENT_HUB_URL"
    fi
    if [ -n "${TIER_AGENT_API_KEY:-}" ]; then
        env_vars="$env_vars TIER_AGENT_API_KEY=$TIER_AGENT_API_KEY"
    fi

    nohup env $env_vars node dist/cli.js serve --port $API_PORT > "$CORE_LOG" 2>&1 &

    local pid=$!
    echo "$pid" > "$CORE_PID_FILE"

    # Wait for server to start
    echo -n "Waiting for server to start"
    for i in {1..10}; do
        sleep 1
        echo -n "."
        if check_api_health; then
            echo ""
            echo -e "${GREEN}Core API started on port $API_PORT (PID: $pid)${NC}"
            echo -e "${CYAN}   URL: http://localhost:$API_PORT${NC}"
            return 0
        fi
    done

    echo ""
    echo -e "${RED}Failed to start Core API. Check $CORE_LOG${NC}"
    return 1
}

# Function to stop Core API server
stop_core() {
    echo -e "${BLUE}Stopping Core API...${NC}"

    local pid=$(get_process_pid "$CORE_PID_FILE" "$API_PORT")
    local stopped=false

    if [ -n "$pid" ]; then
        kill_process_tree "$pid" TERM
        sleep 1

        # Force kill if still running
        if kill -0 "$pid" 2>/dev/null; then
            echo -e "${YELLOW}   Process didn't terminate gracefully, forcing...${NC}"
            kill_process_tree "$pid" KILL
        fi
        stopped=true
    fi

    # Kill anything still holding the port
    local port_pids=$(lsof -i ":$API_PORT" -t 2>/dev/null)
    for port_pid in $port_pids; do
        if [ -n "$port_pid" ]; then
            echo -e "${YELLOW}   Killing process on port $API_PORT: $port_pid${NC}"
            kill -9 "$port_pid" 2>/dev/null
            stopped=true
        fi
    done

    rm -f "$CORE_PID_FILE"

    if [ "$stopped" = true ]; then
        echo -e "${GREEN}Core API stopped${NC}"
    else
        echo -e "${YELLOW}Core API was not running${NC}"
    fi
}

# Function to restart Core API server
restart_core() {
    echo -e "${BLUE}Restarting Core API...${NC}"
    stop_core
    sleep 2
    start_core

    # Auto-reconnect hub client if configured
    if is_hub_configured && check_api_health; then
        echo ""
        echo -e "${BLUE}Auto-reconnecting Hub Client...${NC}"
        sleep 3
        local hub_status=$(curl -s "http://localhost:$API_PORT/hub/status" 2>/dev/null)
        local hub_auth=$(echo "$hub_status" | jq -r '.data.authenticated // false' 2>/dev/null)
        local hub_gw=$(echo "$hub_status" | jq -r '.data.gatewayId // ""' 2>/dev/null)

        if [ "$hub_auth" = "true" ]; then
            echo -e "${GREEN}Hub Client reconnected (gateway: ${hub_gw})${NC}"
        else
            echo -e "${YELLOW}Hub Client connecting... (will auto-retry)${NC}"
        fi
    fi
}

# ============================================================================
# Web Functions
# ============================================================================

# Function to check web dependencies
check_web_deps() {
    # Workspace hoists node_modules to root; check there
    if [ ! -d "$PROJECT_ROOT/node_modules" ]; then
        echo -e "${YELLOW}Installing dependencies...${NC}"
        cd "$PROJECT_ROOT"
        npm install > /dev/null 2>&1
        if [ $? -ne 0 ]; then
            echo -e "${RED}Failed to install dependencies${NC}"
            return 1
        fi
    fi
    return 0
}

# Function to start web
start_web() {
    echo -e "${BLUE}Starting Web...${NC}"

    if [ ! -d "$WEB_DIR" ]; then
        echo -e "${RED}Web directory not found: $WEB_DIR${NC}"
        return 1
    fi

    if check_port $WEB_PORT; then
        if check_port_responding $WEB_PORT 3; then
            echo -e "${YELLOW}Web is already running on port $WEB_PORT${NC}"
            return 0
        else
            # Port in use but not responding - stuck process
            echo -e "${YELLOW}Port $WEB_PORT is occupied by a stuck process, cleaning up...${NC}"
            local stuck_pids=$(lsof -i ":$WEB_PORT" -t 2>/dev/null)
            for pid in $stuck_pids; do
                kill_process_tree "$pid" KILL
            done
            sleep 2
        fi
    fi

    check_web_deps || return 1

    cd "$WEB_DIR"

    # Check web build status
    local web_build_status=$(check_web_build_status)
    if [ "$web_build_status" = "not-built" ] || [ "$web_build_status" = "outdated" ]; then
        echo -e "${YELLOW}Web build is $web_build_status. Building first...${NC}"
        build_web
        if [ $? -ne 0 ]; then
            return 1
        fi
    fi

    # Start the production server
    nohup npx next start -p $WEB_PORT > "$WEB_LOG" 2>&1 &

    local pid=$!
    echo "$pid" > "$WEB_PID_FILE"

    # Wait for server to start
    echo -n "Waiting for Web to start"
    for i in {1..15}; do
        sleep 1
        echo -n "."
        if check_port $WEB_PORT && check_port_responding $WEB_PORT 2; then
            echo ""
            echo -e "${GREEN}Web started on port $WEB_PORT (PID: $pid)${NC}"
            echo -e "${CYAN}   URL: http://localhost:$WEB_PORT${NC}"
            return 0
        fi
    done

    echo ""
    echo -e "${RED}Failed to start Web. Check $WEB_LOG${NC}"

    # Show last few lines of log for debugging
    if [ -f "$WEB_LOG" ]; then
        echo -e "${YELLOW}Last 10 lines of log:${NC}"
        tail -10 "$WEB_LOG"
    fi

    return 1
}

# Function to stop web
stop_web() {
    echo -e "${BLUE}Stopping Web...${NC}"

    local pid=$(get_process_pid "$WEB_PID_FILE" "$WEB_PORT")
    local stopped=false

    if [ -n "$pid" ]; then
        kill_process_tree "$pid" TERM
        sleep 1

        # Force kill if still running
        if kill -0 "$pid" 2>/dev/null; then
            echo -e "${YELLOW}   Process didn't terminate gracefully, forcing...${NC}"
            kill_process_tree "$pid" KILL
        fi
        stopped=true
    fi

    # Kill anything still holding the port
    local port_pids=$(lsof -i ":$WEB_PORT" -t 2>/dev/null)
    for port_pid in $port_pids; do
        if [ -n "$port_pid" ]; then
            echo -e "${YELLOW}   Killing process on port $WEB_PORT: $port_pid${NC}"
            kill -9 "$port_pid" 2>/dev/null
            stopped=true
        fi
    done

    rm -f "$WEB_PID_FILE"

    if [ "$stopped" = true ]; then
        echo -e "${GREEN}Web stopped${NC}"
    else
        echo -e "${YELLOW}Web was not running${NC}"
    fi
}

# Function to restart web
restart_web() {
    echo -e "${BLUE}Restarting Web...${NC}"
    stop_web
    sleep 2
    start_web
}

# ============================================================================
# Hub Client Functions
# ============================================================================

# Function to show detailed hub status
show_hub_status() {
    echo -e "${BLUE}Hub Client Status:${NC}"
    echo ""
    if ! is_hub_configured; then
        echo -e "  Configured:  ${RED}No${NC}"
        echo -e "  ${YELLOW}Set TIER_AGENT_API_KEY and TIER_AGENT_HUB_URL in .env${NC}"
    elif ! check_api_health; then
        echo -e "  Configured:  ${GREEN}Yes${NC}"
        echo -e "  Hub URL:     ${CYAN}${TIER_AGENT_HUB_URL}${NC}"
        echo -e "  API Key:     ${CYAN}${TIER_AGENT_API_KEY:0:16}...${NC}"
        echo -e "  API Server:  ${RED}Not running${NC}"
    else
        local hub_json=$(curl -s "http://localhost:$API_PORT/hub/status" 2>/dev/null)
        local hub_connected=$(echo "$hub_json" | jq -r '.data.connected // false' 2>/dev/null)
        local hub_auth=$(echo "$hub_json" | jq -r '.data.authenticated // false' 2>/dev/null)
        local hub_gw=$(echo "$hub_json" | jq -r '.data.gatewayId // "none"' 2>/dev/null)
        local hub_url=$(echo "$hub_json" | jq -r '.data.hubUrl // "unknown"' 2>/dev/null)
        local hub_retries=$(echo "$hub_json" | jq -r '.data.reconnectAttempts // 0' 2>/dev/null)
        local hub_last=$(echo "$hub_json" | jq -r '.data.lastConnected // "never"' 2>/dev/null)
        local hub_key_prefix=$(echo "$hub_json" | jq -r '.data.apiKeyPrefix // "***"' 2>/dev/null)

        echo -e "  Configured:      ${GREEN}Yes${NC}"
        echo -e "  Hub URL:         ${CYAN}${hub_url}${NC}"
        echo -e "  API Key:         ${CYAN}${hub_key_prefix}${NC}"

        if [ "$hub_auth" = "true" ]; then
            echo -e "  Status:          ${GREEN}Connected & Authenticated${NC}"
            echo -e "  Gateway ID:      ${CYAN}${hub_gw}${NC}"
        elif [ "$hub_connected" = "true" ]; then
            echo -e "  Status:          ${YELLOW}Connected (auth pending)${NC}"
        else
            echo -e "  Status:          ${RED}Disconnected${NC}"
            if [ "$hub_retries" -gt 0 ] 2>/dev/null; then
                echo -e "  Reconnect:       ${YELLOW}Attempt ${hub_retries}${NC}"
            fi
        fi

        if [ "$hub_last" != "never" ] && [ "$hub_last" != "null" ]; then
            echo -e "  Last Connected:  ${CYAN}${hub_last}${NC}"
        fi
    fi
    echo ""
}

# Function to start/connect the hub client
start_hub() {
    echo -e "${BLUE}Starting Hub Client...${NC}"

    if ! check_api_health; then
        echo -e "${RED}Core API is not running. Start it first: $0 start core${NC}"
        return 1
    fi

    if ! is_hub_configured; then
        echo -e "${RED}Hub not configured. Set TIER_AGENT_API_KEY and TIER_AGENT_HUB_URL in .env${NC}"
        return 1
    fi

    # Check if already connected
    local status=$(curl -s "http://localhost:$API_PORT/hub/status" 2>/dev/null)
    local connected=$(echo "$status" | jq -r '.data.connected // false' 2>/dev/null)

    if [ "$connected" = "true" ]; then
        local gw_id=$(echo "$status" | jq -r '.data.gatewayId // "unknown"' 2>/dev/null)
        echo -e "${YELLOW}Hub Client already connected (gateway: ${gw_id})${NC}"
        return 0
    fi

    # Connect
    local result=$(curl -s -X POST "http://localhost:$API_PORT/hub/connect" 2>/dev/null)
    local success=$(echo "$result" | jq -r '.success // false' 2>/dev/null)

    if [ "$success" = "true" ]; then
        sleep 2
        local post_status=$(curl -s "http://localhost:$API_PORT/hub/status" 2>/dev/null)
        local auth=$(echo "$post_status" | jq -r '.data.authenticated // false' 2>/dev/null)
        local gw_id=$(echo "$post_status" | jq -r '.data.gatewayId // "pending"' 2>/dev/null)

        if [ "$auth" = "true" ]; then
            echo -e "${GREEN}Hub Client connected & authenticated (gateway: ${gw_id})${NC}"
            echo -e "${CYAN}   Hub URL: ${TIER_AGENT_HUB_URL}${NC}"
        else
            echo -e "${YELLOW}Hub Client connected, authentication pending...${NC}"
            echo -e "${CYAN}   Hub URL: ${TIER_AGENT_HUB_URL}${NC}"
        fi
        return 0
    else
        local error=$(echo "$result" | jq -r '.error // "Unknown error"' 2>/dev/null)
        echo -e "${RED}Failed to start Hub Client: ${error}${NC}"
        echo -e "${YELLOW}   Hub will auto-retry connection in background${NC}"
        return 1
    fi
}

# Function to stop/disconnect the hub client
stop_hub() {
    echo -e "${BLUE}Stopping Hub Client...${NC}"

    if ! check_api_health; then
        echo -e "${YELLOW}Core API is not running - Hub Client already stopped${NC}"
        return 0
    fi

    local result=$(curl -s -X POST "http://localhost:$API_PORT/hub/disconnect" 2>/dev/null)
    local success=$(echo "$result" | jq -r '.success // false' 2>/dev/null)

    if [ "$success" = "true" ]; then
        echo -e "${GREEN}Hub Client disconnected${NC}"
    else
        echo -e "${YELLOW}Hub Client was not connected${NC}"
    fi
}

# Function to reconnect the hub client
reconnect_hub() {
    echo -e "${BLUE}Reconnecting Hub Client...${NC}"

    if ! check_api_health; then
        echo -e "${RED}Core API is not running. Start it first: $0 start core${NC}"
        return 1
    fi

    if ! is_hub_configured; then
        echo -e "${RED}Hub not configured. Set TIER_AGENT_API_KEY and TIER_AGENT_HUB_URL in .env${NC}"
        return 1
    fi

    local result=$(curl -s -X POST "http://localhost:$API_PORT/hub/reconnect" 2>/dev/null)
    local success=$(echo "$result" | jq -r '.success // false' 2>/dev/null)

    if [ "$success" = "true" ]; then
        sleep 2
        local post_status=$(curl -s "http://localhost:$API_PORT/hub/status" 2>/dev/null)
        local auth=$(echo "$post_status" | jq -r '.data.authenticated // false' 2>/dev/null)
        local gw_id=$(echo "$post_status" | jq -r '.data.gatewayId // "pending"' 2>/dev/null)

        if [ "$auth" = "true" ]; then
            echo -e "${GREEN}Hub Client reconnected & authenticated (gateway: ${gw_id})${NC}"
        else
            echo -e "${YELLOW}Hub Client reconnected, authentication pending...${NC}"
        fi
        return 0
    else
        local error=$(echo "$result" | jq -r '.error // "Unknown error"' 2>/dev/null)
        echo -e "${RED}Failed to reconnect Hub Client: ${error}${NC}"
        return 1
    fi
}

# Function to restart the hub client (disconnect + connect)
restart_hub() {
    echo -e "${BLUE}Restarting Hub Client...${NC}"
    stop_hub
    sleep 1
    start_hub
}

# ============================================================================
# Combined Service Functions
# ============================================================================

# Function to start all services
start_all() {
    echo -e "${BLUE}Starting all services...${NC}"
    echo ""
    start_core
    echo ""
    start_web
    echo ""
    echo -e "${GREEN}All services started${NC}"
}

# Function to stop all services
stop_all() {
    echo -e "${BLUE}Stopping all services...${NC}"
    echo ""
    stop_web
    echo ""
    stop_core
    echo ""
    echo -e "${GREEN}All services stopped${NC}"
}

# Function to restart all services
restart_all() {
    echo -e "${BLUE}Restarting all services...${NC}"
    stop_all
    sleep 2
    start_all
}

# ============================================================================
# Status Function
# ============================================================================

# Function to check status of all services
check_status() {
    show_header
    echo -e "${BLUE}Checking service status...${NC}"
    echo ""

    # Worktree indicator
    if [ -n "$WT_NUM" ]; then
        echo -e "${MAGENTA}Worktree $WT_NUM${NC} (ports offset by +$WT_NUM)"
        echo ""
    fi

    # Build Status
    echo -n "Build Status:              "
    local build_status=$(check_build_status)
    case "$build_status" in
        "up-to-date")
            echo -e "${GREEN}Up to date${NC}"
            ;;
        "outdated")
            echo -e "${YELLOW}Outdated (source files changed)${NC}"
            ;;
        "not-built")
            echo -e "${RED}Not built${NC}"
            ;;
    esac

    # Core API Server
    echo -n "Core API (port $API_PORT):    "
    if check_port $API_PORT; then
        if check_api_health; then
            local health=$(curl -s "http://localhost:$API_PORT/health" 2>/dev/null)
            local version=$(echo "$health" | jq -r '.data.version // "unknown"' 2>/dev/null)
            echo -e "${GREEN}Running & Healthy${NC} (v$version)"
        else
            echo -e "${YELLOW}Running (Unhealthy)${NC}"
        fi
    else
        echo -e "${RED}Not Running${NC}"
    fi

    # Web
    echo -n "Web (port $WEB_PORT):         "
    if check_port $WEB_PORT; then
        if check_port_responding $WEB_PORT 3; then
            echo -e "${GREEN}Running${NC}"
        else
            echo -e "${YELLOW}Stuck (port in use but not responding)${NC}"
        fi
    else
        echo -e "${RED}Not Running${NC}"
    fi

    # Hub Client
    echo -n "Hub Client:                "
    if is_hub_configured; then
        if check_api_health; then
            local hub_status=$(curl -s "http://localhost:$API_PORT/hub/status" 2>/dev/null)
            local hub_connected=$(echo "$hub_status" | jq -r '.data.connected // false' 2>/dev/null)
            local hub_auth=$(echo "$hub_status" | jq -r '.data.authenticated // false' 2>/dev/null)
            local hub_gw=$(echo "$hub_status" | jq -r '.data.gatewayId // ""' 2>/dev/null)
            local hub_retries=$(echo "$hub_status" | jq -r '.data.reconnectAttempts // 0' 2>/dev/null)

            if [ "$hub_auth" = "true" ]; then
                echo -e "${GREEN}Connected${NC} (${hub_gw})"
            elif [ "$hub_connected" = "true" ]; then
                echo -e "${YELLOW}Connected (auth pending)${NC}"
            else
                if [ "$hub_retries" -gt 0 ] 2>/dev/null; then
                    echo -e "${YELLOW}Reconnecting (attempt ${hub_retries})${NC}"
                else
                    echo -e "${RED}Disconnected${NC}"
                fi
            fi
        else
            echo -e "${RED}Core API not running${NC}"
        fi
    else
        echo -e "${YELLOW}Not configured${NC} (set TIER_AGENT_API_KEY in .env)"
    fi

    echo ""

    # Node.js Version
    echo -n "Node.js:                   "
    local node_version=$(node --version 2>/dev/null || echo "not installed")
    echo -e "${CYAN}$node_version${NC}"

    # npm Version
    echo -n "npm:                       "
    local npm_version=$(npm --version 2>/dev/null || echo "not installed")
    echo -e "${CYAN}$npm_version${NC}"

    echo ""

    # Show URLs if services are running
    if check_port $API_PORT || check_port $WEB_PORT; then
        echo -e "${BLUE}Service URLs:${NC}"
        if check_port $API_PORT; then
            echo -e "  Core API:  ${CYAN}http://localhost:$API_PORT${NC}"
        fi
        if check_port $WEB_PORT; then
            echo -e "  Web:       ${CYAN}http://localhost:$WEB_PORT${NC}"
        fi
        if is_hub_configured; then
            echo -e "  Hub:       ${CYAN}${TIER_AGENT_HUB_URL}${NC}"
        fi
        echo ""
    fi
}

# ============================================================================
# Test Function
# ============================================================================

# Function to test API endpoints
test_api() {
    if ! check_port $API_PORT || ! check_api_health; then
        echo -e "${RED}Core API is not running${NC}"
        return 1
    fi

    echo -e "${BLUE}Testing API Endpoints...${NC}"
    echo ""

    # Health check
    echo -n "GET /health:     "
    local health=$(curl -s -w "%{http_code}" -o /tmp/lm-health.json "http://localhost:$API_PORT/health")
    if [ "$health" = "200" ]; then
        echo -e "${GREEN}OK${NC}"
    else
        echo -e "${RED}Failed ($health)${NC}"
    fi

    # Status check
    echo -n "GET /status:     "
    local status=$(curl -s -w "%{http_code}" -o /tmp/lm-status.json "http://localhost:$API_PORT/status")
    if [ "$status" = "200" ]; then
        echo -e "${GREEN}OK${NC}"
    else
        echo -e "${RED}Failed ($status)${NC}"
    fi

    # Sessions list
    echo -n "GET /sessions:   "
    local sessions=$(curl -s -w "%{http_code}" -o /tmp/lm-sessions.json "http://localhost:$API_PORT/sessions")
    if [ "$sessions" = "200" ]; then
        echo -e "${GREEN}OK${NC}"
    else
        echo -e "${RED}Failed ($sessions)${NC}"
    fi

    echo ""
    echo -e "${GREEN}API test complete${NC}"
}

# ============================================================================
# Log Functions
# ============================================================================

# Function to view logs by service name (CLI mode)
view_logs_cli() {
    local service="$1"

    case "$service" in
        core|api)
            if [ -f "$CORE_LOG" ]; then
                tail -100 "$CORE_LOG"
            else
                echo "No Core API log found"
            fi
            ;;
        web)
            if [ -f "$WEB_LOG" ]; then
                tail -100 "$WEB_LOG"
            else
                echo "No Web log found"
            fi
            ;;
        hub)
            if [ -f "$CORE_LOG" ]; then
                echo -e "${BLUE}Hub Client logs (from Core API log):${NC}"
                grep -i '\[Hub\|hub\|gateway\|websocket' "$CORE_LOG" | tail -100
            else
                echo "No Core API log (Hub logs are part of the Core API log)"
            fi
            ;;
        *)
            echo "Usage: $0 logs [core|web|hub]"
            ;;
    esac
}

# Function to view logs (interactive menu)
view_logs_menu() {
    echo -e "${CYAN}=============================================================${NC}"
    echo -e "${CYAN}  Log Viewer${NC}"
    echo -e "${CYAN}=============================================================${NC}"
    echo ""
    echo "  1) Core API Log"
    echo "  2) Web Log"
    echo "  3) Build Log"
    echo "  4) Follow Core API Log (tail -f)"
    echo "  5) Follow Web Log (tail -f)"
    echo "  0) Back to Menu"
    echo ""
    read -p "Select log to view: " log_choice

    case $log_choice in
        1)
            if [ -f "$CORE_LOG" ]; then
                less "$CORE_LOG"
            else
                echo -e "${YELLOW}No Core API log found${NC}"
            fi
            ;;
        2)
            if [ -f "$WEB_LOG" ]; then
                less "$WEB_LOG"
            else
                echo -e "${YELLOW}No Web log found${NC}"
            fi
            ;;
        3)
            if [ -f "$BUILD_LOG" ]; then
                less "$BUILD_LOG"
            else
                echo -e "${YELLOW}No build log found${NC}"
            fi
            ;;
        4)
            if [ -f "$CORE_LOG" ]; then
                echo -e "${YELLOW}Press Ctrl+C to exit${NC}"
                tail -f "$CORE_LOG"
            else
                echo -e "${YELLOW}No Core API log found${NC}"
            fi
            ;;
        5)
            if [ -f "$WEB_LOG" ]; then
                echo -e "${YELLOW}Press Ctrl+C to exit${NC}"
                tail -f "$WEB_LOG"
            else
                echo -e "${YELLOW}No Web log found${NC}"
            fi
            ;;
    esac
}

# ============================================================================
# Interactive Menu
# ============================================================================

# Function to show main menu
show_menu() {
    show_header
    echo -e "${CYAN}Service Management:${NC}"
    echo ""
    echo "  1) Check Status"
    echo "  2) Start All Services"
    echo "  3) Stop All Services"
    echo ""
    echo -e "${CYAN}Core API:${NC}"
    echo "  4) Start Core API"
    echo "  5) Stop Core API"
    echo "  6) Restart Core API"
    echo ""
    echo -e "${CYAN}Web:${NC}"
    echo "  7) Start Web"
    echo "  8) Stop Web"
    echo "  9) Restart Web"
    echo ""
    echo -e "${CYAN}Build Management:${NC}"
    echo "  10) Build Core (TypeScript)"
    echo "  11) Clean & Rebuild Core"
    echo ""
    echo -e "${CYAN}Tools:${NC}"
    echo "  12) View Logs"
    echo "  13) Test API Endpoints"
    echo ""
    echo "  0) Exit"
    echo ""
    echo -e "${CYAN}=============================================================${NC}"
    echo ""
}

# Function to handle menu selection
handle_menu() {
    local choice=$1

    case $choice in
        1)
            check_status
            ;;
        2)
            start_all
            ;;
        3)
            stop_all
            ;;
        4)
            start_core
            ;;
        5)
            stop_core
            ;;
        6)
            restart_core
            ;;
        7)
            start_web
            ;;
        8)
            stop_web
            ;;
        9)
            restart_web
            ;;
        10)
            build_project
            ;;
        11)
            clean_build
            ;;
        12)
            view_logs_menu
            ;;
        13)
            test_api
            ;;
        0)
            echo -e "${GREEN}Goodbye!${NC}"
            exit 0
            ;;
        *)
            echo -e "${RED}Invalid option${NC}"
            ;;
    esac
}

# Main menu loop
main_loop() {
    # Check prerequisites first
    if ! check_prerequisites; then
        exit 1
    fi

    while true; do
        show_menu
        read -p "Select option: " choice
        handle_menu "$choice"
        echo ""
        read -p "Press Enter to continue..."
    done
}

# ============================================================================
# CLI Interface
# ============================================================================

# Handle command line arguments
case "${1:-}" in
    start)
        case "${2:-}" in
            core|api)
                start_core
                ;;
            web)
                start_web
                ;;
            hub)
                start_hub
                ;;
            all)
                start_all
                ;;
            *)
                # Default: start all services
                start_all
                ;;
        esac
        ;;
    stop)
        case "${2:-}" in
            core|api)
                stop_core
                ;;
            web)
                stop_web
                ;;
            hub)
                stop_hub
                ;;
            all)
                stop_all
                ;;
            *)
                # Default: stop all services
                stop_all
                ;;
        esac
        ;;
    restart)
        case "${2:-}" in
            core|api)
                restart_core
                ;;
            web)
                restart_web
                ;;
            hub)
                restart_hub
                ;;
            all)
                restart_all
                ;;
            *)
                # Default: restart all services
                restart_all
                ;;
        esac
        ;;
    status)
        check_status
        ;;
    build)
        build_project
        ;;
    clean)
        clean_build
        ;;
    test)
        test_api
        ;;
    logs)
        view_logs_cli "${2:-}"
        ;;
    hub)
        case "${2:-}" in
            start|connect)
                start_hub
                ;;
            stop|disconnect)
                stop_hub
                ;;
            restart)
                restart_hub
                ;;
            reconnect)
                reconnect_hub
                ;;
            status)
                show_hub_status
                ;;
            logs)
                if [ -f "$CORE_LOG" ]; then
                    echo -e "${BLUE}Hub Client Logs (from Core API log):${NC}"
                    grep -i '\[Hub' "$CORE_LOG" | tail -50
                else
                    echo -e "${YELLOW}No Core API log found${NC}"
                fi
                ;;
            *)
                echo "Usage: $0 hub [start|stop|restart|reconnect|status|logs]"
                echo ""
                echo "Hub Client commands:"
                echo "  start      - Connect to Hub (uses .env API key)"
                echo "  stop       - Disconnect from Hub (stops auto-reconnect)"
                echo "  restart    - Disconnect and reconnect Hub client"
                echo "  reconnect  - Reconnect Hub client (preserves state)"
                echo "  status     - Show detailed Hub connection status"
                echo "  logs       - Show recent Hub client log entries"
                echo ""
                echo "Configuration (.env):"
                echo "  TIER_AGENT_API_KEY    API key for hub authentication"
                echo "  TIER_AGENT_HUB_URL    Hub WebSocket URL (e.g. wss://hub.example.com)"
                echo ""
                echo "The Hub client auto-connects on Core API start and auto-reconnects"
                echo "on disconnect. Use 'restart' to force a clean reconnection."
                ;;
        esac
        ;;
    help|--help|-h)
        echo "Usage: $0 [command] [service] [options]"
        echo ""
        echo "Commands:"
        echo "  start [service]   Start a service (default: all)"
        echo "  stop [service]    Stop a service (default: all)"
        echo "  restart [service] Restart a service (default: all)"
        echo "  status            Show all service status"
        echo "  build             Build Core (TypeScript)"
        echo "  clean             Clean and rebuild Core"
        echo "  test              Test API endpoints"
        echo "  logs [service]    View service logs"
        echo "  hub [command]     Hub client management"
        echo "  help              Show this help"
        echo ""
        echo "Services:"
        echo "  core (or api)  Core API Server (port $API_PORT)"
        echo "  web            Web Server (port $WEB_PORT)"
        echo "  hub            Hub Client (auto-starts with Core API)"
        echo "  all            All services (default)"
        echo ""
        echo "Examples:"
        echo "  $0                     Interactive menu"
        echo "  $0 start               Start all services"
        echo "  $0 start core          Start Core API only"
        echo "  $0 start web           Start Web only"
        echo "  $0 stop                Stop all services"
        echo "  $0 restart core        Restart Core API"
        echo "  $0 status              Check status of all services"
        echo "  $0 build               Build Core TypeScript"
        echo "  $0 clean               Clean and rebuild"
        echo "  $0 test                Test API endpoints"
        echo "  $0 logs core           View Core API logs"
        echo "  $0 logs web            View Web logs"
        echo "  $0 logs hub            View Hub client logs"
        echo "  $0 hub start           Connect Hub Client"
        echo "  $0 hub status          Detailed Hub connection info"
        echo "  $0 hub logs            View Hub Client logs"
        echo ""
        echo "Without arguments, starts interactive menu."
        ;;
    "")
        main_loop
        ;;
    *)
        echo "Unknown command: $1"
        echo "Use '$0 help' for usage information"
        exit 1
        ;;
esac
