#!/bin/bash
# ─────────────────────────────────────────────────────────────────
#  GunpointBots Panel — One-Click Installer v2
#  Supports: Ubuntu 20.04+, Debian 11+
# ─────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

REPO_URL="https://github.com/IamGunpoint/gunpointbots.git"
INSTALL_DIR="/opt/gunpointbots"
SERVICE_NAME="gunpointbots"
NODE_VERSION="20"
PNPM_VERSION="9"
MAX_RETRIES=3

# ─── helpers ──────────────────────────────────────────────────────

info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[ OK ]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERR ]${NC}  $*"; exit 1; }
step()    { echo -e "\n${BOLD}${CYAN}▶ $*${NC}"; }
ask()     { echo -en "${BOLD}  $* ${NC}"; }

# Run a command up to $MAX_RETRIES times before failing
retry() {
  local label="$1"; shift
  local attempt=1
  while [[ $attempt -le $MAX_RETRIES ]]; do
    if "$@" ; then return 0; fi
    warn "[$label] Attempt $attempt/$MAX_RETRIES failed. Retrying..."
    attempt=$(( attempt + 1 ))
    sleep 3
  done
  error "[$label] Failed after $MAX_RETRIES attempts."
}

require_root() {
  [[ $EUID -eq 0 ]] || error "Run as root: sudo bash installer.sh"
}

detect_os() {
  [[ -f /etc/os-release ]] || error "Cannot detect OS. Only Ubuntu/Debian supported."
  . /etc/os-release
  OS=$ID
  OS_VERSION=$VERSION_ID
  case "$OS" in
    ubuntu|debian) ;;
    *) error "Unsupported OS: $OS. Use Ubuntu 20.04+ or Debian 11+." ;;
  esac
  info "Detected: $OS $OS_VERSION"
}

# ─── banner ───────────────────────────────────────────────────────

print_banner() {
  clear
  echo -e "${CYAN}${BOLD}"
  echo "  ██████╗ ██╗   ██╗███╗   ██╗██████╗  ██████╗ ██╗███╗   ██╗████████╗"
  echo "  ██╔════╝██║   ██║████╗  ██║██╔══██╗██╔═══██╗██║████╗  ██║╚══██╔══╝"
  echo "  ██║  ███╗██║   ██║██╔██╗ ██║██████╔╝██║   ██║██║██╔██╗ ██║   ██║  "
  echo "  ██║   ██║██║   ██║██║╚██╗██║██╔═══╝ ██║   ██║██║██║╚██╗██║   ██║  "
  echo "  ╚██████╔╝╚██████╔╝██║ ╚████║██║     ╚██████╔╝██║██║ ╚████║   ██║  "
  echo "   ╚═════╝  ╚═════╝ ╚═╝  ╚═══╝╚═╝      ╚═════╝ ╚═╝╚═╝  ╚═══╝   ╚═╝  "
  echo -e "${NC}${BOLD}              Bot Hosting Panel — One-Click Installer v2${NC}"
  echo ""
}

# ─── prompt for config ────────────────────────────────────────────

collect_config() {
  echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BOLD}  Configuration${NC}"
  echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""

  ask "Panel port [default: 8080]:"; read -r INPUT_PORT
  APP_PORT="${INPUT_PORT:-8080}"

  ask "PostgreSQL database name [default: gunpointbots]:"; read -r INPUT_DB_NAME
  DB_NAME="${INPUT_DB_NAME:-gunpointbots}"

  ask "PostgreSQL user [default: gbpanel]:"; read -r INPUT_DB_USER
  DB_USER="${INPUT_DB_USER:-gbpanel}"

  while true; do
    ask "PostgreSQL password (required):"; read -rs DB_PASS; echo ""
    [[ -n "$DB_PASS" ]] && break
    warn "Password cannot be empty."
  done

  ask "JWT session secret [blank = auto-generate]:"; read -r INPUT_SECRET
  if [[ -z "$INPUT_SECRET" ]]; then
    SESSION_SECRET=$(openssl rand -hex 32)
    info "Auto-generated session secret."
  else
    SESSION_SECRET="$INPUT_SECRET"
  fi

  echo ""
  ask "Create admin account? [Y/n]:"; read -r CREATE_ADMIN
  CREATE_ADMIN="${CREATE_ADMIN:-Y}"

  if [[ "$CREATE_ADMIN" =~ ^[Yy]$ ]]; then
    ask "Admin username [default: admin]:"; read -r INPUT_ADMIN_USER
    ADMIN_USER="${INPUT_ADMIN_USER:-admin}"
    while true; do
      ask "Admin password (min 8 chars):"; read -rs ADMIN_PASS; echo ""
      [[ ${#ADMIN_PASS} -ge 8 ]] && break
      warn "Password must be at least 8 characters."
    done
  fi

  echo ""
  ask "Set up Nginx reverse proxy? [y/N]:"; read -r SETUP_NGINX
  SETUP_NGINX="${SETUP_NGINX:-N}"

  if [[ "$SETUP_NGINX" =~ ^[Yy]$ ]]; then
    ask "Domain name (e.g. panel.example.com):"; read -r DOMAIN_NAME
    if [[ -z "$DOMAIN_NAME" ]]; then
      warn "No domain entered. Skipping Nginx."
      SETUP_NGINX="N"
    fi
  fi

  echo ""
  echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "  Port:       ${CYAN}$APP_PORT${NC}"
  echo -e "  DB:         ${CYAN}$DB_NAME${NC} (user: ${CYAN}$DB_USER${NC})"
  echo -e "  Admin:      ${CYAN}${ADMIN_USER:-'(skipped)'}${NC}"
  echo -e "  Nginx:      ${CYAN}$SETUP_NGINX${NC}$( [[ "$SETUP_NGINX" =~ ^[Yy]$ ]] && echo "  (domain: ${CYAN}$DOMAIN_NAME${NC})" )"
  echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  ask "Looks good? Start installation? [Y/n]:"; read -r CONFIRM
  [[ "${CONFIRM:-Y}" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }
}

# ─── system packages ──────────────────────────────────────────────

install_system_deps() {
  step "System dependencies"
  info "Updating package lists..."
  retry "apt-get update" apt-get update -qq

  info "Installing required packages..."
  retry "apt-get install core" apt-get install -y -qq \
    curl wget git build-essential ca-certificates gnupg lsb-release \
    openssl procps psmisc unzip software-properties-common \
    python3 python3-pip python3-venv

  success "System packages ready."
}

# ─── node.js ──────────────────────────────────────────────────────

install_node() {
  step "Node.js"

  # Check existing version
  if command -v node &>/dev/null; then
    CURRENT_NODE=$(node --version 2>/dev/null | grep -oP '\d+' | head -1)
    if [[ "$CURRENT_NODE" -ge "$NODE_VERSION" ]]; then
      success "Node.js $(node --version) already installed."
      return
    fi
    warn "Node.js $CURRENT_NODE found but need $NODE_VERSION+. Upgrading..."
    apt-get remove -y -qq nodejs 2>/dev/null || true
  fi

  info "Installing Node.js $NODE_VERSION via NodeSource..."
  retry "nodesource setup" bash -c "curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - 2>/dev/null"
  retry "nodejs install"   apt-get install -y -qq nodejs

  # Verify
  command -v node &>/dev/null || error "Node.js install failed — node not in PATH."
  success "Node.js $(node --version) installed."
}

# ─── pnpm ─────────────────────────────────────────────────────────

install_pnpm() {
  step "pnpm"

  if command -v pnpm &>/dev/null; then
    success "pnpm $(pnpm --version) already installed."
    return
  fi

  info "Installing pnpm $PNPM_VERSION..."
  retry "pnpm install" npm install -g "pnpm@$PNPM_VERSION" --quiet

  # Add pnpm home to PATH
  export PNPM_HOME="/root/.local/share/pnpm"
  export PATH="$PNPM_HOME:$PATH"

  command -v pnpm &>/dev/null || error "pnpm install failed — pnpm not in PATH."
  success "pnpm $(pnpm --version) installed."
}

# ─── postgresql ───────────────────────────────────────────────────

install_postgres() {
  step "PostgreSQL"

  if ! command -v psql &>/dev/null; then
    info "Installing PostgreSQL..."
    retry "pg install" apt-get install -y -qq postgresql postgresql-contrib
    systemctl enable postgresql --quiet
    success "PostgreSQL installed."
  else
    success "PostgreSQL already installed."
  fi

  # Ensure service is running
  if ! systemctl is-active --quiet postgresql; then
    info "Starting PostgreSQL service..."
    systemctl start postgresql || retry "pg start" systemctl start postgresql
  fi
  success "PostgreSQL is running."
}

# ─── database setup ───────────────────────────────────────────────

setup_database() {
  step "Database setup"

  # Wait for postgres to be ready (up to 15s)
  local waited=0
  until sudo -u postgres psql -c "SELECT 1" &>/dev/null; do
    sleep 1; waited=$(( waited + 1 ))
    [[ $waited -ge 15 ]] && error "PostgreSQL is not accepting connections after 15s."
  done

  if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" 2>/dev/null | grep -q 1; then
    info "DB user '$DB_USER' already exists."
    # Update password in case it changed
    sudo -u postgres psql -c "ALTER USER $DB_USER WITH PASSWORD '$DB_PASS';" 2>/dev/null
  else
    sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';" 2>/dev/null
    success "DB user '$DB_USER' created."
  fi

  if sudo -u postgres psql -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw "$DB_NAME"; then
    info "Database '$DB_NAME' already exists."
  else
    sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;" 2>/dev/null
    success "Database '$DB_NAME' created."
  fi

  sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;" 2>/dev/null
  sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL ON SCHEMA public TO $DB_USER;" 2>/dev/null

  DATABASE_URL="postgresql://$DB_USER:$DB_PASS@localhost:5432/$DB_NAME"
  success "Database ready."
}

# ─── clone repo ───────────────────────────────────────────────────

clone_repo() {
  step "Repository"

  if [[ -d "$INSTALL_DIR/.git" ]]; then
    info "Repo exists — pulling latest..."
    cd "$INSTALL_DIR"
    git pull origin main 2>/dev/null || warn "Could not pull latest. Using existing code."
  else
    info "Cloning from GitHub..."
    retry "git clone" git clone "$REPO_URL" "$INSTALL_DIR"
  fi

  [[ -f "$INSTALL_DIR/package.json" ]] || error "Clone succeeded but package.json missing — check repo structure."
  success "Repository ready at $INSTALL_DIR."
}

# ─── .env file ────────────────────────────────────────────────────

write_env() {
  step ".env file"
  cat > "$INSTALL_DIR/.env" <<EOF
DATABASE_URL=$DATABASE_URL
SESSION_SECRET=$SESSION_SECRET
PORT=$APP_PORT
NODE_ENV=production
EOF
  chmod 600 "$INSTALL_DIR/.env"
  success ".env written."
}

# ─── npm dependencies ─────────────────────────────────────────────

install_deps() {
  step "npm dependencies"
  cd "$INSTALL_DIR"

  export PNPM_HOME="/root/.local/share/pnpm"
  export PATH="$PNPM_HOME:$PATH"

  info "Running pnpm install (may take a few minutes)..."

  # Try frozen first, fall back to no-frozen if lockfile is stale
  if ! pnpm install --frozen-lockfile 2>/tmp/pnpm_err; then
    warn "Frozen install failed — retrying without frozen lockfile..."
    if ! pnpm install --no-frozen-lockfile 2>/tmp/pnpm_err; then
      echo ""
      cat /tmp/pnpm_err
      error "pnpm install failed. See errors above."
    fi
  fi

  success "Dependencies installed."
}

# ─── db schema push ───────────────────────────────────────────────

push_schema() {
  step "Database schema"
  cd "$INSTALL_DIR"
  export DATABASE_URL

  # Retry up to 3 times (postgres may need a moment after first install)
  local attempt=1
  while [[ $attempt -le 3 ]]; do
    if pnpm --filter @workspace/db run push 2>/tmp/schema_err; then
      success "Database schema pushed."
      return
    fi
    warn "Schema push attempt $attempt/3 failed. Waiting 3s..."
    sleep 3
    attempt=$(( attempt + 1 ))
  done

  echo ""
  cat /tmp/schema_err
  error "Schema push failed after 3 attempts. Check DATABASE_URL and PostgreSQL status."
}

# ─── build ────────────────────────────────────────────────────────

build_app() {
  step "Build"
  cd "$INSTALL_DIR"

  info "Building api-server..."
  if ! pnpm --filter @workspace/api-server run build 2>/tmp/build_err; then
    echo ""
    cat /tmp/build_err
    error "Build failed. See TypeScript errors above."
  fi

  [[ -f "$INSTALL_DIR/artifacts/api-server/dist/index.mjs" ]] || \
    error "Build finished but dist/index.mjs not found — something went wrong."

  success "Build complete."
}

# ─── admin account ────────────────────────────────────────────────

ensure_python_bcrypt() {
  if python3 -c "import bcrypt" &>/dev/null; then return; fi

  info "Installing Python bcrypt..."
  # Try system package first (no pip needed)
  apt-get install -y -qq python3-bcrypt 2>/dev/null && \
    python3 -c "import bcrypt" &>/dev/null && return

  # Fall back to pip
  pip3 install bcrypt --quiet 2>/dev/null || \
    python3 -m pip install bcrypt --break-system-packages --quiet 2>/dev/null || true

  python3 -c "import bcrypt" &>/dev/null || \
    error "Cannot install Python bcrypt. Try: pip3 install bcrypt"
}

create_admin() {
  [[ "$CREATE_ADMIN" =~ ^[Yy]$ ]] || return

  step "Admin account"
  ensure_python_bcrypt

  # Generate bcrypt hash with Python (avoids all Node module issues)
  ADMIN_HASH=$(python3 - <<PYEOF 2>/dev/null
import bcrypt
pw = b"""${ADMIN_PASS}"""
print(bcrypt.hashpw(pw, bcrypt.gensalt(12)).decode())
PYEOF
)

  if [[ -z "$ADMIN_HASH" ]]; then
    warn "Could not hash password. Skipping admin creation."
    return
  fi

  # Upsert via psql — no ON CONFLICT without knowing the exact columns,
  # so do a manual exists-check
  EXISTS=$(sudo -u postgres psql -d "$DB_NAME" -tAc \
    "SELECT 1 FROM users WHERE username='${ADMIN_USER}'" 2>/dev/null)

  if [[ "$EXISTS" == "1" ]]; then
    sudo -u postgres psql -d "$DB_NAME" -c \
      "UPDATE users SET password_hash='${ADMIN_HASH}', role='admin' WHERE username='${ADMIN_USER}';" \
      2>/dev/null && success "Admin '${ADMIN_USER}' updated." || \
      warn "Admin update failed. Try again after panel starts."
  else
    sudo -u postgres psql -d "$DB_NAME" -c \
      "INSERT INTO users (username, password_hash, role) VALUES ('${ADMIN_USER}', '${ADMIN_HASH}', 'admin');" \
      2>/dev/null && success "Admin '${ADMIN_USER}' created." || \
      warn "Admin insert failed. Try: POST /api/auth/register after panel starts."
  fi
}

# ─── systemd service ──────────────────────────────────────────────

setup_service() {
  step "Systemd service"

  # Find node binary
  NODE_BIN=$(command -v node) || error "node binary not found after install."

  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=GunpointBots Panel
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR/artifacts/api-server
ExecStart=$NODE_BIN --enable-source-maps $INSTALL_DIR/artifacts/api-server/dist/index.mjs
Restart=always
RestartSec=5
EnvironmentFile=$INSTALL_DIR/.env
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SERVICE_NAME
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" --quiet
  systemctl restart "$SERVICE_NAME"

  # Wait up to 10 seconds for it to come up
  info "Waiting for panel to start..."
  local waited=0
  until curl -sf "http://127.0.0.1:$APP_PORT/api/healthz" &>/dev/null; do
    sleep 1; waited=$(( waited + 1 ))
    if [[ $waited -ge 15 ]]; then
      warn "Panel didn't respond in 15s. Check: journalctl -u $SERVICE_NAME -n 50"
      return
    fi
  done

  success "Panel is up and responding on port $APP_PORT."
}

# ─── nginx ────────────────────────────────────────────────────────

setup_nginx() {
  if [[ ! "$SETUP_NGINX" =~ ^[Yy]$ ]]; then
    # If nginx is installed but nginx was NOT requested, make sure
    # it's not blocking our port (leave it as-is, just warn)
    if systemctl is-active --quiet nginx 2>/dev/null; then
      warn "Nginx is running but you didn't configure it for this panel."
      warn "If port 80 shows the nginx default page, run:"
      warn "  sudo rm /etc/nginx/sites-enabled/default && sudo systemctl reload nginx"
    fi
    return
  fi

  step "Nginx"
  apt-get install -y -qq nginx

  # ── CRITICAL: disable the default nginx site ──────────────────
  rm -f /etc/nginx/sites-enabled/default
  # Also remove any leftover default configs
  [[ -f /etc/nginx/conf.d/default.conf ]] && mv /etc/nginx/conf.d/default.conf /etc/nginx/conf.d/default.conf.bak

  cat > "/etc/nginx/sites-available/$SERVICE_NAME" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN_NAME;

    client_max_body_size 100M;

    # Health check (no proxy overhead)
    location = /api/healthz {
        proxy_pass http://127.0.0.1:$APP_PORT;
    }

    location / {
        proxy_pass         http://127.0.0.1:$APP_PORT;
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
EOF

  ln -sf "/etc/nginx/sites-available/$SERVICE_NAME" "/etc/nginx/sites-enabled/"

  # Test and reload
  if nginx -t 2>/tmp/nginx_err; then
    systemctl enable nginx --quiet
    systemctl reload nginx 2>/dev/null || systemctl restart nginx
    success "Nginx configured: $DOMAIN_NAME → localhost:$APP_PORT"
  else
    cat /tmp/nginx_err
    warn "Nginx config test failed — nginx not reloaded. Fix manually with: nginx -t"
    return
  fi

  # Optional SSL
  echo ""
  ask "Install Let's Encrypt SSL certificate? [y/N]:"; read -r SETUP_SSL
  SETUP_SSL="${SETUP_SSL:-N}"
  if [[ "$SETUP_SSL" =~ ^[Yy]$ ]]; then
    apt-get install -y -qq certbot python3-certbot-nginx
    retry "certbot" certbot --nginx -d "$DOMAIN_NAME" \
      --non-interactive --agree-tos --register-unsafely-without-email || \
      warn "Certbot failed. Set up SSL manually later."
  fi
}

# ─── firewall ─────────────────────────────────────────────────────

open_firewall() {
  step "Firewall"
  if ! command -v ufw &>/dev/null; then
    info "ufw not installed — skipping firewall config."
    return
  fi
  if ! ufw status 2>/dev/null | grep -q "Status: active"; then
    info "ufw is inactive — skipping firewall config."
    return
  fi

  ufw allow "$APP_PORT/tcp" --quiet 2>/dev/null || true
  ufw allow "22/tcp"        --quiet 2>/dev/null || true   # keep SSH open!
  if [[ "$SETUP_NGINX" =~ ^[Yy]$ ]]; then
    ufw allow "Nginx Full"  --quiet 2>/dev/null || true
  fi
  success "Firewall updated (port $APP_PORT open)."
}

# ─── summary ──────────────────────────────────────────────────────

print_summary() {
  SERVER_IP=$(curl -s --connect-timeout 3 ifconfig.me 2>/dev/null || \
              curl -s --connect-timeout 3 icanhazip.com 2>/dev/null || \
              hostname -I 2>/dev/null | awk '{print $1}')

  echo ""
  echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}${BOLD}  ✓  GunpointBots Panel installed successfully!${NC}"
  echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""

  if [[ "$SETUP_NGINX" =~ ^[Yy]$ ]]; then
    echo -e "  ${BOLD}Panel URL:${NC}    http://$DOMAIN_NAME"
    echo -e "  ${BOLD}Direct API:${NC}   http://$SERVER_IP:$APP_PORT/api"
  else
    echo -e "  ${BOLD}Panel URL:${NC}    http://$SERVER_IP:$APP_PORT"
    echo -e "  ${BOLD}API:${NC}          http://$SERVER_IP:$APP_PORT/api"
  fi

  echo -e "  ${BOLD}Health:${NC}       http://$SERVER_IP:$APP_PORT/api/healthz"
  echo ""

  if [[ "$CREATE_ADMIN" =~ ^[Yy]$ ]]; then
    echo -e "  ${BOLD}Admin user:${NC}   $ADMIN_USER"
    echo -e "  ${BOLD}Admin pass:${NC}   (the password you entered)"
  fi

  echo ""
  echo -e "  ${BOLD}Useful commands:${NC}"
  echo -e "    ${CYAN}systemctl status $SERVICE_NAME${NC}      — service status"
  echo -e "    ${CYAN}systemctl restart $SERVICE_NAME${NC}     — restart"
  echo -e "    ${CYAN}journalctl -u $SERVICE_NAME -f${NC}      — live logs"
  echo -e "    ${CYAN}systemctl stop $SERVICE_NAME${NC}        — stop"
  echo ""
  echo -e "  ${BOLD}Files:${NC}"
  echo -e "    ${CYAN}$INSTALL_DIR${NC}                — install dir"
  echo -e "    ${CYAN}$INSTALL_DIR/.env${NC}           — environment config"
  echo ""

  # Quick connectivity test
  if curl -sf "http://127.0.0.1:$APP_PORT/api/healthz" &>/dev/null; then
    echo -e "  ${GREEN}${BOLD}✓ Panel is live and responding.${NC}"
  else
    echo -e "  ${YELLOW}⚠ Panel did not respond to health check.${NC}"
    echo -e "  Run: ${CYAN}journalctl -u $SERVICE_NAME -n 50${NC}"
  fi

  echo ""
  echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
}

# ─── main ─────────────────────────────────────────────────────────

main() {
  print_banner
  require_root
  detect_os
  collect_config

  echo ""
  info "Starting installation..."
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
  setup_service
  setup_nginx   # nginx AFTER service so it can proxy a live panel

  print_summary
}

main "$@"
