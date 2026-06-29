#!/usr/bin/env bash
# =============================================================================
#  GunpointBots Panel — One-Click Installer v3
#  Supports: Ubuntu 20.04+ / Debian 11+
#  Usage:
#    sudo bash installer.sh
#    sudo bash installer.sh --reinstall   # force reinstall everything
#    sudo bash installer.sh --uninstall   # remove the panel
# =============================================================================
set -o pipefail

# ── colours ───────────────────────────────────────────────────────────────────
R='\033[0;31m' G='\033[0;32m' Y='\033[1;33m' C='\033[0;36m' B='\033[1m' N='\033[0m'

# ── constants ─────────────────────────────────────────────────────────────────
REPO_URL="https://github.com/IamGunpoint/gunpointbots.git"
INSTALL_DIR="/opt/gunpointbots"
SERVICE_NAME="gunpointbots"
LOG_FILE="/var/log/gunpointbots-install.log"
STATE_FILE="/var/lib/gunpointbots-install.state"
NODE_VERSION="20"
PNPM_VERSION="9"
MAX_RETRIES=4

# ── helpers ───────────────────────────────────────────────────────────────────
info()  { echo -e "${C}[INFO]${N}  $*" | tee -a "$LOG_FILE"; }
ok()    { echo -e "${G}[ OK ]${N}  $*" | tee -a "$LOG_FILE"; }
warn()  { echo -e "${Y}[WARN]${N}  $*" | tee -a "$LOG_FILE"; }
die()   { echo -e "${R}[FAIL]${N}  $*" | tee -a "$LOG_FILE"; echo -e "\n  Full log: ${C}$LOG_FILE${N}\n"; exit 1; }
ask()   { echo -en "${B}  $* ${N}"; }
hdr()   { echo -e "\n${B}${C}▶  $*${N}"; }

# Save / restore install progress so --resume works
state_set() { mkdir -p "$(dirname "$STATE_FILE")"; echo "$1=done" >> "$STATE_FILE"; }
state_done() { grep -q "^$1=done" "$STATE_FILE" 2>/dev/null; }

# Run cmd, retry up to MAX_RETRIES times, optional fallback
# retry <label> <cmd...>
retry() {
  local label="$1"; shift
  local n=1
  while true; do
    if "$@" >> "$LOG_FILE" 2>&1; then return 0; fi
    if [[ $n -ge $MAX_RETRIES ]]; then
      warn "[$label] failed after $MAX_RETRIES attempts — continuing if non-fatal"
      return 1
    fi
    warn "[$label] attempt $n/$MAX_RETRIES failed, retrying in ${n}s..."
    sleep "$n"; n=$(( n + 1 ))
  done
}

# apt install with automatic retry + fix-broken
apt_install() {
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    -o Dpkg::Options::="--force-confdef" \
    -o Dpkg::Options::="--force-confold" \
    "$@" >> "$LOG_FILE" 2>&1 || {
    warn "apt install failed for: $*. Trying apt --fix-broken..."
    apt-get -f install -y -qq >> "$LOG_FILE" 2>&1 || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >> "$LOG_FILE" 2>&1
  }
}

require_root() {
  [[ $EUID -eq 0 ]] || die "Run as root:  sudo bash installer.sh"
}

detect_os() {
  [[ -f /etc/os-release ]] || die "Cannot detect OS. Only Ubuntu/Debian supported."
  # shellcheck source=/dev/null
  . /etc/os-release
  OS=$ID; OS_VER=$VERSION_ID
  case "$OS" in
    ubuntu|debian) ;;
    *) die "Unsupported OS: $OS $OS_VER. Use Ubuntu 20.04+ or Debian 11+." ;;
  esac
  info "OS: $OS $OS_VER"
}

# ── banner ────────────────────────────────────────────────────────────────────
banner() {
  clear
  echo -e "${C}${B}"
  echo "  ██████╗ ██╗   ██╗███╗   ██╗██████╗  ██████╗ ██╗███╗   ██╗████████╗"
  echo "  ██╔════╝██║   ██║████╗  ██║██╔══██╗██╔═══██╗██║████╗  ██║╚══██╔══╝"
  echo "  ██║  ███╗██║   ██║██╔██╗ ██║██████╔╝██║   ██║██║██╔██╗ ██║   ██║  "
  echo "  ██║   ██║██║   ██║██║╚██╗██║██╔═══╝ ██║   ██║██║██║╚██╗██║   ██║  "
  echo "  ╚██████╔╝╚██████╔╝██║ ╚████║██║     ╚██████╔╝██║██║ ╚████║   ██║  "
  echo "   ╚═════╝  ╚═════╝ ╚═╝  ╚═══╝╚═╝      ╚═════╝ ╚═╝╚═╝  ╚═══╝   ╚═╝  "
  echo -e "${N}${B}                  Bot Hosting Panel — Installer v3${N}"
  echo ""
}

# ── uninstall ─────────────────────────────────────────────────────────────────
do_uninstall() {
  echo -e "${Y}This will stop and remove the GunpointBots panel service and files.${N}"
  ask "Are you sure? [y/N]:"; read -r CONFIRM
  [[ "${CONFIRM,,}" == "y" ]] || { echo "Aborted."; exit 0; }

  systemctl stop "$SERVICE_NAME"   2>/dev/null || true
  systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
  systemctl daemon-reload 2>/dev/null || true

  # Remove nginx site if present
  rm -f "/etc/nginx/sites-enabled/$SERVICE_NAME" "/etc/nginx/sites-available/$SERVICE_NAME"
  systemctl reload nginx 2>/dev/null || true

  rm -rf "$INSTALL_DIR"
  rm -f "$STATE_FILE"
  ok "Panel removed. Database and PostgreSQL were NOT removed."
  exit 0
}

# ── collect config ────────────────────────────────────────────────────────────
collect_config() {
  echo -e "${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
  echo -e "${B}  Setup Configuration${N}"
  echo -e "${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
  echo ""

  ask "Panel port [8080]:"; read -r v; APP_PORT="${v:-8080}"
  ask "PostgreSQL database name [gunpointbots]:"; read -r v; DB_NAME="${v:-gunpointbots}"
  ask "PostgreSQL username [gbpanel]:"; read -r v; DB_USER="${v:-gbpanel}"

  while true; do
    ask "PostgreSQL password (required):"; read -rs DB_PASS; echo ""
    [[ -n "$DB_PASS" ]] && break; warn "Password cannot be empty."
  done

  ask "JWT secret [blank = auto-generate]:"; read -r v
  SESSION_SECRET="${v:-$(openssl rand -hex 40)}"
  [[ -z "$v" ]] && info "Session secret auto-generated."

  echo ""
  ask "Create admin account? [Y/n]:"; read -r v
  CREATE_ADMIN="${v:-Y}"

  if [[ "${CREATE_ADMIN,,}" == "y" ]]; then
    ask "Admin username [admin]:"; read -r v; ADMIN_USER="${v:-admin}"
    while true; do
      ask "Admin password (min 8 chars):"; read -rs ADMIN_PASS; echo ""
      [[ ${#ADMIN_PASS} -ge 8 ]] && break; warn "Must be at least 8 characters."
    done
  fi

  echo ""
  ask "Set up Nginx reverse proxy? [y/N]:"; read -r v
  SETUP_NGINX="${v:-N}"
  if [[ "${SETUP_NGINX,,}" == "y" ]]; then
    ask "Domain (e.g. panel.example.com):"; read -r DOMAIN_NAME
    if [[ -z "$DOMAIN_NAME" ]]; then
      warn "No domain entered. Skipping Nginx."
      SETUP_NGINX="N"
    fi
  fi

  DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}"

  echo ""
  echo -e "${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
  echo -e "  Port       ${C}$APP_PORT${N}"
  echo -e "  DB         ${C}$DB_NAME${N}  user: ${C}$DB_USER${N}"
  echo -e "  Admin      ${C}${ADMIN_USER:-'(skipped)'}${N}"
  echo -e "  Nginx      ${C}${SETUP_NGINX}${N}$( [[ "${SETUP_NGINX,,}" == "y" ]] && echo "  → ${C}$DOMAIN_NAME${N}" )"
  echo -e "${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
  echo ""
  ask "Confirm and start installation? [Y/n]:"; read -r v
  [[ "${v:-Y}" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }
}

# ── step: system packages ─────────────────────────────────────────────────────
install_system_deps() {
  state_done "system_deps" && ! $REINSTALL && { ok "System deps already installed."; return; }
  hdr "System packages"

  info "Updating package lists..."
  retry "apt-update" apt-get update -qq

  info "Installing core packages..."
  apt_install \
    curl wget git build-essential ca-certificates gnupg lsb-release \
    openssl procps psmisc unzip software-properties-common \
    python3 python3-pip python3-venv python3-bcrypt \
    net-tools

  # python3-bcrypt might not exist on older Ubuntu, fall back to pip
  python3 -c "import bcrypt" 2>/dev/null || \
    pip3 install bcrypt --quiet 2>>"$LOG_FILE" || \
    python3 -m pip install bcrypt --break-system-packages --quiet 2>>"$LOG_FILE" || \
    warn "Python bcrypt install failed — will retry during admin creation."

  state_set "system_deps"
  ok "System packages ready."
}

# ── step: node.js ─────────────────────────────────────────────────────────────
install_node() {
  hdr "Node.js"

  # Check existing
  if command -v node &>/dev/null; then
    CUR=$(node --version 2>/dev/null | grep -oP '\d+' | head -1)
    if [[ "$CUR" -ge "$NODE_VERSION" ]]; then
      ok "Node.js $(node --version) already installed."
      return
    fi
    warn "Node.js v$CUR is too old (need $NODE_VERSION+). Upgrading..."
    apt-get remove -y -qq nodejs 2>>"$LOG_FILE" || true
  fi

  info "Installing Node.js $NODE_VERSION..."

  # Method 1: NodeSource
  if retry "nodesource-setup" bash -c \
      "curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -"; then
    apt_install nodejs
  else
    # Method 2: nvm fallback
    warn "NodeSource failed. Trying nvm..."
    export NVM_DIR="/root/.nvm"
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash >>"$LOG_FILE" 2>&1
    # shellcheck source=/dev/null
    [[ -s "$NVM_DIR/nvm.sh" ]] && source "$NVM_DIR/nvm.sh"
    nvm install "$NODE_VERSION" >>"$LOG_FILE" 2>&1
    nvm use "$NODE_VERSION"     >>"$LOG_FILE" 2>&1
    nvm alias default "$NODE_VERSION" >>"$LOG_FILE" 2>&1
    # Symlink so systemd can find it
    NODE_BIN=$(command -v node 2>/dev/null)
    [[ -n "$NODE_BIN" ]] && ln -sf "$NODE_BIN" /usr/local/bin/node
    [[ -x "$(command -v npm 2>/dev/null)" ]] || die "Both NodeSource and nvm failed. Install Node.js $NODE_VERSION manually."
  fi

  command -v node &>/dev/null || die "node not found in PATH after install."
  ok "Node.js $(node --version) installed."
}

# ── step: pnpm ────────────────────────────────────────────────────────────────
install_pnpm() {
  hdr "pnpm"

  if command -v pnpm &>/dev/null && ! $REINSTALL; then
    ok "pnpm $(pnpm --version) already installed."
    return
  fi

  # Set pnpm home and PATH
  export PNPM_HOME="/root/.local/share/pnpm"
  export PATH="$PNPM_HOME:$PATH"

  # Method 1: npm global install
  info "Installing pnpm $PNPM_VERSION..."
  if ! retry "pnpm-npm" npm install -g "pnpm@$PNPM_VERSION" --quiet; then
    # Method 2: standalone installer
    warn "npm install failed. Trying pnpm standalone installer..."
    retry "pnpm-standalone" bash -c \
      "curl -fsSL https://get.pnpm.io/install.sh | PNPM_VERSION=$PNPM_VERSION bash -"
    [[ -s "$PNPM_HOME/pnpm" ]] || die "pnpm installation failed via both methods."
  fi

  command -v pnpm &>/dev/null || die "pnpm not in PATH after install."
  ok "pnpm $(pnpm --version) installed."
}

# ── step: postgresql ──────────────────────────────────────────────────────────
install_postgres() {
  hdr "PostgreSQL"

  if command -v psql &>/dev/null && ! $REINSTALL; then
    ok "PostgreSQL already installed."
  else
    info "Installing PostgreSQL..."
    apt_install postgresql postgresql-contrib
    ok "PostgreSQL installed."
  fi

  # Enable + start
  systemctl enable postgresql --quiet 2>>"$LOG_FILE" || true
  systemctl start  postgresql       2>>"$LOG_FILE" || true

  # Wait up to 20 seconds
  local n=0
  until sudo -u postgres psql -c "SELECT 1" &>/dev/null; do
    sleep 1; n=$(( n+1 ))
    [[ $n -ge 20 ]] && die "PostgreSQL not accepting connections after 20s. Check: systemctl status postgresql"
  done
  ok "PostgreSQL is running."
}

# ── step: database ────────────────────────────────────────────────────────────
setup_database() {
  hdr "Database"

  # Create / update user
  if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" 2>/dev/null | grep -q 1; then
    info "DB user '$DB_USER' exists — updating password."
    sudo -u postgres psql -c "ALTER USER \"$DB_USER\" WITH PASSWORD '$DB_PASS';" >> "$LOG_FILE" 2>&1
  else
    sudo -u postgres psql -c "CREATE USER \"$DB_USER\" WITH PASSWORD '$DB_PASS';" >> "$LOG_FILE" 2>&1
    ok "DB user '$DB_USER' created."
  fi

  # Create / verify database
  if ! sudo -u postgres psql -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw "$DB_NAME"; then
    sudo -u postgres psql -c "CREATE DATABASE \"$DB_NAME\" OWNER \"$DB_USER\";" >> "$LOG_FILE" 2>&1
    ok "Database '$DB_NAME' created."
  else
    info "Database '$DB_NAME' exists."
    sudo -u postgres psql -c "ALTER DATABASE \"$DB_NAME\" OWNER TO \"$DB_USER\";" >> "$LOG_FILE" 2>&1
  fi

  # Permissions
  sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE \"$DB_NAME\" TO \"$DB_USER\";" >> "$LOG_FILE" 2>&1
  sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL ON SCHEMA public TO \"$DB_USER\";" >> "$LOG_FILE" 2>&1

  ok "Database ready."
}

# ── step: clone repo ──────────────────────────────────────────────────────────
clone_repo() {
  hdr "Repository"

  if $REINSTALL && [[ -d "$INSTALL_DIR" ]]; then
    info "Reinstall mode: removing old installation..."
    systemctl stop "$SERVICE_NAME" 2>/dev/null || true
    rm -rf "$INSTALL_DIR"
  fi

  if [[ -d "$INSTALL_DIR/.git" ]]; then
    info "Repo exists — pulling latest..."
    cd "$INSTALL_DIR"
    git pull origin main >> "$LOG_FILE" 2>&1 || warn "Git pull failed — using existing code."
  else
    info "Cloning from GitHub..."
    retry "git-clone" git clone "$REPO_URL" "$INSTALL_DIR"
  fi

  [[ -f "$INSTALL_DIR/package.json" ]] || die "Clone OK but package.json not found. Check repo structure."
  ok "Repository ready at $INSTALL_DIR."
}

# ── step: .env ────────────────────────────────────────────────────────────────
write_env() {
  hdr ".env"
  cat > "$INSTALL_DIR/.env" <<EOF
DATABASE_URL=${DATABASE_URL}
SESSION_SECRET=${SESSION_SECRET}
PORT=${APP_PORT}
NODE_ENV=production
EOF
  chmod 600 "$INSTALL_DIR/.env"
  ok ".env written."
}

# ── step: npm deps ────────────────────────────────────────────────────────────
install_deps() {
  hdr "npm dependencies"
  cd "$INSTALL_DIR"

  export PNPM_HOME="/root/.local/share/pnpm"
  export PATH="$PNPM_HOME:$PATH"

  info "Running pnpm install (may take a few minutes)..."

  # Try 1: frozen
  if pnpm install --frozen-lockfile >> "$LOG_FILE" 2>&1; then
    ok "Dependencies installed (frozen)."
    return
  fi

  warn "Frozen install failed — retrying without lockfile freeze..."
  # Try 2: no-frozen
  if pnpm install --no-frozen-lockfile >> "$LOG_FILE" 2>&1; then
    ok "Dependencies installed."
    return
  fi

  # Try 3: clear cache + retry
  warn "Second attempt failed — clearing pnpm cache and retrying..."
  pnpm store prune >> "$LOG_FILE" 2>&1 || true
  if pnpm install --no-frozen-lockfile >> "$LOG_FILE" 2>&1; then
    ok "Dependencies installed (after cache clear)."
    return
  fi

  die "pnpm install failed after 3 attempts. Check: $LOG_FILE"
}

# ── step: schema push ─────────────────────────────────────────────────────────
push_schema() {
  hdr "Database schema"
  cd "$INSTALL_DIR"
  export DATABASE_URL

  local n=1
  while [[ $n -le 4 ]]; do
    if pnpm --filter @workspace/db run push >> "$LOG_FILE" 2>&1; then
      ok "Schema pushed."
      return
    fi
    warn "Schema push attempt $n/4 failed. Waiting ${n}s..."
    sleep "$n"; n=$(( n+1 ))
  done
  die "Schema push failed after 4 attempts. Check: $LOG_FILE"
}

# ── step: build ───────────────────────────────────────────────────────────────
build_app() {
  hdr "Build"
  cd "$INSTALL_DIR"
  export PNPM_HOME="/root/.local/share/pnpm"
  export PATH="$PNPM_HOME:$PATH"

  info "Building api-server..."
  if ! pnpm --filter @workspace/api-server run build >> "$LOG_FILE" 2>&1; then
    # Show last 30 lines of log to help debug
    echo ""
    echo -e "${Y}--- Build errors (last 30 lines) ---${N}"
    tail -30 "$LOG_FILE"
    echo -e "${Y}--- End build errors ---${N}"
    die "Build failed. See errors above or check: $LOG_FILE"
  fi

  [[ -f "$INSTALL_DIR/artifacts/api-server/dist/index.mjs" ]] || \
    die "Build finished but dist/index.mjs missing."

  ok "Build complete."
}

# ── step: admin account ───────────────────────────────────────────────────────
ensure_python_bcrypt() {
  python3 -c "import bcrypt" 2>/dev/null && return

  warn "Python bcrypt not found. Installing..."

  # Method 1: system package
  apt_install python3-bcrypt 2>/dev/null && \
    python3 -c "import bcrypt" 2>/dev/null && return

  # Method 2: pip
  pip3 install bcrypt --quiet 2>>"$LOG_FILE" && \
    python3 -c "import bcrypt" 2>/dev/null && return

  # Method 3: pip with --break-system-packages (Debian 12+)
  python3 -m pip install bcrypt --break-system-packages --quiet 2>>"$LOG_FILE" && \
    python3 -c "import bcrypt" 2>/dev/null && return

  warn "Could not install Python bcrypt — admin account will be skipped."
  return 1
}

create_admin() {
  [[ "${CREATE_ADMIN,,}" == "y" ]] || return 0

  hdr "Admin account"

  ensure_python_bcrypt || {
    warn "Admin creation skipped. Create admin via API after startup:"
    warn "  POST /api/auth/register  {username, password, email}"
    warn "  Then manually set role='admin' in the DB."
    return 0
  }

  # Generate bcrypt hash with Python
  ADMIN_HASH=$(python3 - 2>>"$LOG_FILE" <<PYEOF
import bcrypt, sys
try:
    pw = """${ADMIN_PASS}""".encode()
    hashed = bcrypt.hashpw(pw, bcrypt.gensalt(12))
    print(hashed.decode())
except Exception as e:
    print("ERROR:" + str(e), file=sys.stderr)
    sys.exit(1)
PYEOF
)

  if [[ -z "$ADMIN_HASH" || "$ADMIN_HASH" == ERROR:* ]]; then
    warn "Could not generate bcrypt hash. Admin creation skipped."
    return 0
  fi

  # Check if user already exists
  EXISTS=$(sudo -u postgres psql -d "$DB_NAME" -tAc \
    "SELECT id FROM users WHERE username='${ADMIN_USER}' LIMIT 1" 2>/dev/null)

  if [[ -n "$EXISTS" ]]; then
    # Update existing
    sudo -u postgres psql -d "$DB_NAME" -c \
      "UPDATE users SET password_hash='${ADMIN_HASH}', role='admin', is_suspended=false WHERE username='${ADMIN_USER}';" \
      >> "$LOG_FILE" 2>&1 && ok "Admin '${ADMIN_USER}' updated." || \
      warn "Admin update failed — try again manually."
  else
    # Insert new — only required columns, let DB handle defaults
    sudo -u postgres psql -d "$DB_NAME" -c \
      "INSERT INTO users (username, password_hash, role) VALUES ('${ADMIN_USER}', '${ADMIN_HASH}', 'admin');" \
      >> "$LOG_FILE" 2>&1 && ok "Admin '${ADMIN_USER}' created." || {
        warn "INSERT failed — trying with all columns..."
        sudo -u postgres psql -d "$DB_NAME" -c \
          "INSERT INTO users (username, password_hash, role, is_suspended, force_password_change, theme, language)
           VALUES ('${ADMIN_USER}', '${ADMIN_HASH}', 'admin', false, false, 'dark', 'en');" \
          >> "$LOG_FILE" 2>&1 && ok "Admin '${ADMIN_USER}' created." || \
          warn "Admin creation failed. You can register after the panel starts."
      }
  fi
}

# ── step: systemd service ─────────────────────────────────────────────────────
setup_service() {
  hdr "Systemd service"

  NODE_BIN=$(command -v node 2>/dev/null) || die "node binary not found. Is Node.js installed?"

  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=GunpointBots Panel
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}/artifacts/api-server
ExecStart=${NODE_BIN} --enable-source-maps ${INSTALL_DIR}/artifacts/api-server/dist/index.mjs
Restart=always
RestartSec=5
StartLimitBurst=5
StartLimitIntervalSec=60
EnvironmentFile=${INSTALL_DIR}/.env
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" --quiet
  systemctl restart "$SERVICE_NAME"

  # Wait for health endpoint — up to 20 seconds
  info "Waiting for panel to start on port $APP_PORT..."
  local n=0
  until curl -sf "http://127.0.0.1:${APP_PORT}/api/healthz" &>/dev/null; do
    sleep 1; n=$(( n+1 ))
    if [[ $n -ge 20 ]]; then
      warn "Panel didn't respond in 20s. Showing last 20 log lines:"
      journalctl -u "$SERVICE_NAME" -n 20 --no-pager 2>/dev/null || true
      warn "Continue anyway. Check: journalctl -u $SERVICE_NAME -f"
      return 0
    fi
  done
  ok "Panel is live on port $APP_PORT."
}

# ── step: nginx ───────────────────────────────────────────────────────────────
setup_nginx() {
  if [[ "${SETUP_NGINX,,}" != "y" ]]; then
    # If nginx is already running and serving port 80, warn user
    if systemctl is-active --quiet nginx 2>/dev/null; then
      warn "Nginx is running but you didn't configure it for this panel."
      warn "If port 80 shows the nginx default page instead of your panel, run:"
      warn "  rm /etc/nginx/sites-enabled/default && systemctl reload nginx"
    fi
    return 0
  fi

  hdr "Nginx"
  apt_install nginx

  # ── Remove default site — this is what caused the blank nginx page ──
  rm -f /etc/nginx/sites-enabled/default
  [[ -f /etc/nginx/conf.d/default.conf ]] && \
    mv /etc/nginx/conf.d/default.conf /etc/nginx/conf.d/default.conf.disabled

  cat > "/etc/nginx/sites-available/${SERVICE_NAME}" <<NGINXEOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN_NAME};

    client_max_body_size 100M;

    location / {
        proxy_pass         http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
    }
}
NGINXEOF

  ln -sf "/etc/nginx/sites-available/${SERVICE_NAME}" "/etc/nginx/sites-enabled/"

  if nginx -t >> "$LOG_FILE" 2>&1; then
    systemctl enable nginx --quiet 2>>"$LOG_FILE" || true
    systemctl reload nginx 2>>"$LOG_FILE" || systemctl restart nginx 2>>"$LOG_FILE" || true
    ok "Nginx configured: $DOMAIN_NAME → localhost:$APP_PORT"
  else
    warn "Nginx config test failed. Fix manually: nginx -t"
    return 0
  fi

  # Optional SSL
  echo ""
  ask "Install SSL with Let's Encrypt? [y/N]:"; read -r v
  if [[ "${v,,}" == "y" ]]; then
    apt_install certbot python3-certbot-nginx
    if certbot --nginx -d "$DOMAIN_NAME" \
        --non-interactive --agree-tos --register-unsafely-without-email \
        >> "$LOG_FILE" 2>&1; then
      ok "SSL certificate installed."
    else
      warn "Certbot failed. Set up SSL manually later: certbot --nginx -d $DOMAIN_NAME"
    fi
  fi
}

# ── step: firewall ────────────────────────────────────────────────────────────
open_firewall() {
  command -v ufw &>/dev/null || return 0
  ufw status 2>/dev/null | grep -q "Status: active" || return 0

  hdr "Firewall"
  ufw allow 22/tcp      --quiet 2>/dev/null || true   # keep SSH!
  ufw allow "$APP_PORT/tcp" --quiet 2>/dev/null || true
  [[ "${SETUP_NGINX,,}" == "y" ]] && {
    ufw allow 80/tcp  --quiet 2>/dev/null || true
    ufw allow 443/tcp --quiet 2>/dev/null || true
  }
  ok "Firewall updated."
}

# ── summary ───────────────────────────────────────────────────────────────────
print_summary() {
  SERVER_IP=$(curl -sf --connect-timeout 3 https://api.ipify.org 2>/dev/null || \
              curl -sf --connect-timeout 3 https://icanhazip.com 2>/dev/null || \
              hostname -I 2>/dev/null | awk '{print $1}')

  PANEL_URL="http://${SERVER_IP}:${APP_PORT}"
  [[ "${SETUP_NGINX,,}" == "y" ]] && PANEL_URL="http://${DOMAIN_NAME}"

  # Final health check
  HEALTH="unknown"
  curl -sf "http://127.0.0.1:${APP_PORT}/api/healthz" &>/dev/null && HEALTH="ok"

  echo ""
  echo -e "${G}${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
  echo -e "${G}${B}  ✓  GunpointBots Panel installed!${N}"
  echo -e "${G}${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
  echo ""
  echo -e "  ${B}Panel URL:${N}   ${C}${PANEL_URL}${N}"
  echo -e "  ${B}API:${N}         ${C}http://${SERVER_IP}:${APP_PORT}/api${N}"
  echo -e "  ${B}Health:${N}      ${C}http://${SERVER_IP}:${APP_PORT}/api/healthz${N}"
  echo ""
  if [[ "${CREATE_ADMIN,,}" == "y" ]]; then
    echo -e "  ${B}Admin user:${N}  ${C}${ADMIN_USER}${N}"
    echo -e "  ${B}Admin pass:${N}  ${C}(the password you entered)${N}"
  fi
  echo ""
  echo -e "  ${B}Service commands:${N}"
  echo -e "    ${C}systemctl status  ${SERVICE_NAME}${N}   — status"
  echo -e "    ${C}systemctl restart ${SERVICE_NAME}${N}   — restart"
  echo -e "    ${C}systemctl stop    ${SERVICE_NAME}${N}   — stop"
  echo -e "    ${C}journalctl -u ${SERVICE_NAME} -f${N}    — live logs"
  echo ""
  echo -e "  ${B}Files:${N}       ${C}${INSTALL_DIR}${N}"
  echo -e "  ${B}Log:${N}         ${C}${LOG_FILE}${N}"
  echo ""
  if [[ "$HEALTH" == "ok" ]]; then
    echo -e "  ${G}${B}✓ Health check passed — panel is live.${N}"
  else
    echo -e "  ${Y}⚠ Health check failed — check logs:${N}"
    echo -e "    ${C}journalctl -u ${SERVICE_NAME} -n 50 --no-pager${N}"
  fi
  echo ""
  echo -e "${G}${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
  echo ""
}

# ── main ──────────────────────────────────────────────────────────────────────
main() {
  # Parse flags
  REINSTALL=false
  for arg in "$@"; do
    case "$arg" in
      --reinstall) REINSTALL=true ;;
      --uninstall) banner; require_root; do_uninstall ;;
    esac
  done

  # Prepare log file
  mkdir -p "$(dirname "$LOG_FILE")"
  echo "=== GunpointBots Installer v3 — $(date) ===" >> "$LOG_FILE"

  banner
  require_root
  detect_os
  collect_config

  echo ""
  info "Starting installation (log: $LOG_FILE)"
  echo ""

  install_system_deps
  install_node
  install_pnpm
  install_postgres
  setup_database
  clone_repo
  write_env
  install_deps
  push_schema
  build_app
  create_admin
  open_firewall
  setup_service   # service before nginx so nginx proxies a live backend
  setup_nginx

  print_summary
}

main "$@"
