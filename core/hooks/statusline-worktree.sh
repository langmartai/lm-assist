#!/bin/bash
# Claude Code Status Line: Worktree Indicator
# Detects active worktree from session transcript (CWD is always main repo)
# Uses file-path references (tier-agent-wt-N) as the strongest signal
# Caches results keyed by transcript file size for performance

input=$(cat)

# Extract session info
TRANSCRIPT=$(echo "$input" | jq -r '.transcript_path // ""')
PROJECT_DIR=$(echo "$input" | jq -r '.workspace.project_dir // .cwd // ""')
PROJECT_NAME="${PROJECT_DIR##*/}"
CTX_PCT=$(echo "$input" | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)
MODEL=$(echo "$input" | jq -r '.model.display_name // ""')

# Colors
CYAN='\033[36m'
GREEN='\033[32m'
YELLOW='\033[33m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'
BLUE='\033[34m'
RED='\033[31m'

# --- Detect active worktree from transcript ---
CURRENT_WT=""
CACHE_DIR="/tmp/statusline-wt-cache"
mkdir -p "$CACHE_DIR" 2>/dev/null

if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
    CACHE_KEY="$CACHE_DIR/$(echo "$TRANSCRIPT" | md5sum | cut -d' ' -f1)"
    TRANSCRIPT_SIZE=$(stat -c %s "$TRANSCRIPT" 2>/dev/null || echo 0)

    # Cache stores: "size:worktree_number"
    if [ -f "$CACHE_KEY" ]; then
        CACHED=$(cat "$CACHE_KEY")
        CACHED_SIZE="${CACHED%%:*}"
        CACHED_WT="${CACHED#*:}"
        if [ "$CACHED_SIZE" = "$TRANSCRIPT_SIZE" ]; then
            CURRENT_WT="$CACHED_WT"
        fi
    fi

    if [ -z "$CURRENT_WT" ]; then
        # Detect active worktree using recency-weighted file path references.
        # Strong signal: actual file paths (tier-agent-wt-N/ followed by path content)
        # Use tac to reverse the file, take the first 30 strong matches (most recent),
        # then pick the most frequent among those. This handles sessions that
        # create/manage multiple worktrees — only the most recently worked-on one wins.
        CURRENT_WT=$(tac "$TRANSCRIPT" 2>/dev/null \
            | grep -oP 'tier-agent-wt-\K\d+(?=/[a-zA-Z.])' \
            | head -30 \
            | sort | uniq -c | sort -rn \
            | head -1 | awk '{print $2}')

        # Fallback: if no strong file-path refs, try any mention (weaker signal)
        if [ -z "$CURRENT_WT" ]; then
            CURRENT_WT=$(tac "$TRANSCRIPT" 2>/dev/null \
                | grep -oP 'tier-agent-wt-\K\d+' \
                | head -15 \
                | sort | uniq -c | sort -rn \
                | head -1 | awk '{print $2}')
        fi

        # Cache the result (even if empty)
        echo "${TRANSCRIPT_SIZE}:${CURRENT_WT}" > "$CACHE_KEY" 2>/dev/null
    fi
fi

# --- Read current worktree details ---
CURRENT_DESC=""
CURRENT_BRANCH=""
CURRENT_API_PORT=""
CURRENT_DB_PORT=""

if [ -n "$CURRENT_WT" ]; then
    WT_DIR="/home/ubuntu/tier-agent-wt-${CURRENT_WT}"
    if [ -d "$WT_DIR" ] && [ -f "$WT_DIR/.env" ]; then
        CURRENT_DESC=$(grep -m1 '^WORKTREE_DESC=' "$WT_DIR/.env" 2>/dev/null | sed 's/^WORKTREE_DESC=//' | tr -d '"')
        CURRENT_API_PORT=$(grep -m1 '^API_PORT=' "$WT_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '"')
        CURRENT_DB_PORT=$(grep -m1 '^DB_PORT=' "$WT_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '"')
        CURRENT_BRANCH=$(git -C "$WT_DIR" branch --show-current 2>/dev/null)
    fi
fi

# --- Scan all available worktrees ---
WORKTREES=()
for wt_dir in /home/ubuntu/tier-agent-wt-*/; do
    [ -d "$wt_dir" ] || continue
    wt_num=$(basename "$wt_dir" | sed 's/tier-agent-wt-//')
    wt_desc=$(grep -m1 '^WORKTREE_DESC=' "$wt_dir/.env" 2>/dev/null | sed 's/^WORKTREE_DESC=//' | tr -d '"')
    wt_api_port=$((3100 + wt_num))

    # Check if API is running
    if ss -tlnp 2>/dev/null | grep -q ":${wt_api_port} "; then
        wt_status="ON"
    else
        wt_status="--"
    fi

    WORKTREES+=("${wt_num}|${wt_desc}|${wt_status}")
done

# --- Extract last 4 user prompts from transcript ---
if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
    readarray -t PROMPTS < <(python3 -c "
import json,sys
prompts=[]
with open('$TRANSCRIPT') as f:
    lines=f.readlines()
for line in reversed(lines):
    line=line.strip()
    if not line: continue
    d=json.loads(line)
    if d.get('type')!='user': continue
    msg=d.get('message',{})
    c=msg.get('content','') if isinstance(msg,dict) else ''
    if isinstance(c,str) and c and not c.startswith('<'):
        prompts.append(c[:120])
        if len(prompts)>=4: break
for p in prompts: print(p)
" 2>/dev/null)
fi

# --- Detect Claude Code process info (walk up PID ancestry) ---
CC_MEM=""
CC_PID=""
CC_TTY=""
CC_AGE=""
_pid=$$
for _i in 1 2 3 4 5 6 7 8; do
    _ppid=$(awk '{print $4}' /proc/$_pid/stat 2>/dev/null)
    [ -z "$_ppid" ] || [ "$_ppid" -le 1 ] 2>/dev/null && break
    _comm=$(cat /proc/$_ppid/comm 2>/dev/null)
    if [ "$_comm" = "claude-native" ] || [ "$_comm" = "claude" ]; then
        CC_PID="$_ppid"
        # Memory (RSS)
        _rss_kb=$(awk '/VmRSS/{print $2}' /proc/$_ppid/status 2>/dev/null)
        if [ -n "$_rss_kb" ]; then
            _rss_mb=$((_rss_kb / 1024))
            if [ "$_rss_mb" -ge 1024 ] 2>/dev/null; then
                _gb_int=$((_rss_mb / 1024))
                _gb_frac=$(( (_rss_mb % 1024) * 10 / 1024 ))
                CC_MEM="${_gb_int}.${_gb_frac}G"
            else
                CC_MEM="${_rss_mb}M"
            fi
        fi
        # TTY (pts/N)
        _tty_nr=$(awk '{print $7}' /proc/$_ppid/stat 2>/dev/null)
        if [ -n "$_tty_nr" ] && [ "$_tty_nr" -gt 0 ] 2>/dev/null; then
            _minor=$((_tty_nr & 0xff))
            CC_TTY="pts/${_minor}"
        fi
        # Process age
        _start=$(awk '{print $22}' /proc/$_ppid/stat 2>/dev/null)
        if [ -n "$_start" ]; then
            _clk=$(getconf CLK_TCK 2>/dev/null || echo 100)
            _now_ticks=$(awk '{printf "%.0f", $1 * '"$_clk"'}' /proc/uptime 2>/dev/null)
            if [ -n "$_now_ticks" ]; then
                _age_sec=$(( (_now_ticks - _start) / _clk ))
                _age_h=$((_age_sec / 3600))
                _age_m=$(( (_age_sec % 3600) / 60 ))
                if [ "$_age_h" -gt 0 ] 2>/dev/null; then
                    CC_AGE="${_age_h}h${_age_m}m"
                else
                    CC_AGE="${_age_m}m"
                fi
            fi
        fi
        break
    fi
    _pid=$_ppid
done

# --- Context color ---
if [ "$CTX_PCT" -ge 80 ] 2>/dev/null; then
    CTX_COLOR="$RED"
elif [ "$CTX_PCT" -ge 50 ] 2>/dev/null; then
    CTX_COLOR="$YELLOW"
else
    CTX_COLOR="$GREEN"
fi

# --- Render: Last 4 user prompts (oldest first, newest bold) ---
PROMPT_COUNT=${#PROMPTS[@]}
for ((i=PROMPT_COUNT-1; i>=0; i--)); do
    [ -z "${PROMPTS[$i]}" ] && continue
    if [ "$i" -eq 0 ]; then
        printf "${BOLD}${CYAN}> %s${RESET}\n" "${PROMPTS[$i]}"
    else
        printf "${DIM}${CYAN}> %s${RESET}\n" "${PROMPTS[$i]}"
    fi
done

# --- Render Line 2: Project + worktree context ---
printf "${DIM}%s${RESET}" "$PROJECT_DIR"
if [ -n "$CURRENT_WT" ] && [ -n "$CURRENT_DESC" ]; then
    DB_LABEL=""
    if [ "$CURRENT_DB_PORT" = "5432" ] || [ -z "$CURRENT_DB_PORT" ]; then
        DB_LABEL="shared"
    else
        DB_LABEL="isolated:${CURRENT_DB_PORT}"
    fi
    printf " ${BOLD}${CYAN}wt-%s${RESET} ${GREEN}%s${RESET} ${DIM}[%s] api:%s db:%s${RESET}" "$CURRENT_WT" "$CURRENT_DESC" "${CURRENT_BRANCH:-?}" "${CURRENT_API_PORT:-?}" "$DB_LABEL"
elif [ -n "$CURRENT_WT" ]; then
    printf " ${BOLD}${YELLOW}wt-%s${RESET} ${DIM}(not found)${RESET}" "$CURRENT_WT"
else
    printf " ${BOLD}${BLUE}main${RESET}"
fi
echo ""

# --- Render Line 3: Worktree list + context % + model ---
if [ ${#WORKTREES[@]} -gt 0 ]; then
    PARTS=()
    for entry in "${WORKTREES[@]}"; do
        IFS='|' read -r num desc status <<< "$entry"
        if [ ${#desc} -gt 20 ]; then
            desc="${desc:0:18}.."
        fi
        if [ "$num" = "$CURRENT_WT" ]; then
            if [ "$status" = "ON" ]; then
                PARTS+=("$(printf "${BOLD}${GREEN}*${num}${RESET}${DIM}:${desc}${RESET}")")
            else
                PARTS+=("$(printf "${BOLD}${YELLOW}*${num}${RESET}${DIM}:${desc}${RESET}")")
            fi
        else
            if [ "$status" = "ON" ]; then
                PARTS+=("$(printf "${GREEN}${num}${RESET}${DIM}:${desc}${RESET}")")
            else
                PARTS+=("$(printf "${DIM}${num}:${desc}${RESET}")")
            fi
        fi
    done
    printf "wt: "
    printf "%s " "${PARTS[@]}"
else
    printf "${DIM}no worktrees${RESET}"
fi
# System available memory
SYS_AVAIL=$(awk '/MemAvailable/{mb=int($2/1024); if(mb>=1024){gb=int(mb/1024); frac=int((mb%1024)*10/1024); printf "%d.%dG",gb,frac}else{printf "%dM",mb}}' /proc/meminfo 2>/dev/null)

printf " ${CTX_COLOR}ctx:%s%%${RESET}" "$CTX_PCT"
[ -n "$CC_MEM" ] && printf " ${DIM}ram:%s${RESET}" "$CC_MEM"
[ -n "$SYS_AVAIL" ] && printf " ${DIM}free:%s${RESET}" "$SYS_AVAIL"
[ -n "$CC_PID" ] && printf " ${DIM}pid:%s${RESET}" "$CC_PID"
[ -n "$CC_TTY" ] && printf " ${DIM}%s${RESET}" "$CC_TTY"
[ -n "$CC_AGE" ] && printf " ${DIM}up:%s${RESET}" "$CC_AGE"
[ -n "$MODEL" ] && printf " ${DIM}%s${RESET}" "$MODEL"
echo ""
