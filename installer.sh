#!/bin/bash
set -e

# ─────────────────────────────────────────────────────────────────
#  GunpointBots Panel — One-Click Installer
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

# ─── helpers ──────────────────────────────────────────────────────

info()    { echo -e "${CYAN}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC}   $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERR]${NC}  $*"; exit 1; }
ask()     { echo -e "${BOLD}$*${NC}"; }

require_root() {
  if [[ $EUID -ne 0 ]]; then
    error "This installer must be run as root. Try: sudo bash installer.sh"
  fi
}

detect_os() {
  if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    OS=$ID
    OS_VERSION=$VERSION_ID
  else
    error "Cannot detect OS. Only Ubuntu/Debian are supported."
  fi

  case "$OS" in
    ubuntu|debian) ;;
    *) error "Unsupported OS: $OS. Please use Ubuntu 20.04+ or Debian 11+." ;;
  esac

  info "Detected OS: $OS $OS_VERSION"
}

# ─── banner ───────────────────────────────────────────────────────

print_banner() {
  echo ""
  echo -e "${CYAN}${BOLD}"
  echo "  ██████╗ ██╗   ██╗███╗   ██╗██████╗  ██████╗ ██╗███╗   ██╗████████╗"
  echo "  ██╔════╝ ██║   ██║████╗  ██║██╔══██╗██╔═══██╗██║████╗  ██║╚══██╔══╝"
  echo "  ██║  ███╗██║   ██║██╔██╗ ██║██████╔╝██║   ██║██║██╔██╗ ██║   ██║"
  echo "  ██║   ██║██║   ██║██║╚██╗██║██╔═══╝ ██║   ██║██║██║╚██╗██║   ██║"
  echo "  ╚██████╔╝╚██████╔╝██║ ╚████║██║     ╚██████╔╝██║██║ ╚████║   ██║"
  echo "   ╚═════╝  ╚═════╝ ╚═╝  ╚═══╝╚═╝      ╚═════╝ ╚═╝╚═╝  ╚═══╝   ╚═╝"
  echo -e "${NC}"
  echo -e "${BOLD}         Bot Hosting Panel — One-Click Installer${NC}"
  echo ""
}

# ─── prompt for config ────────────────────────────────────────────

collect_config() {
  echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BOLD}  Configuration${NC}"
  echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""

  # Port
  ask "  Panel port [default: 8080]:"
  read -r INPUT_PORT
  APP_PORT="${INPUT_PORT:-8080}"

  # DB name
  ask "  PostgreSQL database name [default: gunpointbots]:"
  read -r INPUT_DB_NAME
  DB_NAME="${INPUT_DB_NAME:-gunpointbots}"

  # DB user
  ask "  PostgreSQL user [default: gbpanel]:"
  read -r INPUT_DB_USER
  DB_USER="${INPUT_DB_USER:-gbpanel}"

  # DB password
  while true; do
    ask "  PostgreSQL password (required, no spaces):"
    read -rs DB_PASS
    echo ""
    if [[ -z "$DB_PASS" ]]; then
      warn "Password cannot be empty. Try again."
    else
      break
    fi
  done

  # Session secret
  ask "  JWT session secret [leave blank to auto-generate]:"
  read -r INPUT_SECRET
  if [[ -z "$INPUT_SECRET" ]]; then
    SESSION_SECRET=$(openssl rand -hex 32)
    info "Auto-generated session secret."
  else
    SESSION_SECRET="$INPUT_SECRET"
  fi

  # Admin account
  echo ""
  ask "  Create admin account? [Y/n]:"
  read -r CREATE_ADMIN
  CREATE_ADMIN="${CREATE_ADMIN:-Y}"

  if [[ "$CREATE_ADMIN" =~ ^[Yy]$ ]]; then
    ask "  Admin username [default: admin]:"
    read -r INPUT_ADMIN_USER
    ADMIN_USER="${INPUT_ADMIN_USER:-admin}"

    while true; do
      ask "  Admin password (min 8 chars):"
      read -rs ADMIN_PASS
      echo ""
      if [[ ${#ADMIN_PASS} -lt 8 ]]; then
        warn "Password must be at least 8 characters."
      else
        break
      fi
    done
  fi

  # Nginx reverse proxy
  echo ""
  ask "  Set up Nginx reverse proxy? [y/N]:"
  read -r SETUP_NGINX
  SETUP_NGINX="${SETUP_NGINX:-N}"

  if [[ "$SETUP_NGINX" =~ ^[Yy]$ ]]; then
    ask "  Domain name (e.g. panel.yourdomain.com) [required for nginx]:"
    read -r DOMAIN_NAME
    if [[ -z "$DOMAIN_NAME" ]]; then
      warn "No domain provided. Skipping nginx setup."
      SETUP_NGINX="N"
    fi
  fi

  echo ""
  echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "  Port:        ${CYAN}$APP_PORT${NC}"
  echo -e "  DB Name:     ${CYAN}$DB_NAME${NC}"
  echo -e "  DB User:     ${CYAN}$DB_USER${NC}"
  echo -e "  Admin user:  ${CYAN}${ADMIN_USER:-'(skipped)'}${NC}"
  echo -e "  Nginx:       ${CYAN}$SETUP_NGINX${NC}"
  if [[ "$SETUP_NGINX" =~ ^[Yy]$ ]]; then
    echo -e "  Domain:      ${CYAN}$DOMAIN_NAME${NC}"
  fi
  echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  ask "  Looks good? Start installation? [Y/n]:"
  read -r CONFIRM
  CONFIRM="${CONFIRM:-Y}"
  if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
}

# ─── install system packages ──────────────────────────────────────

install_system_deps() {
  info "Updating package lists..."
  apt-get update -qq

  info "Installing system dependencies..."
  apt-get install -y -qq \
    curl wget git build-essential ca-certificates gnupg lsb-release \
    openssl procps psmisc unzip software-properties-common \
    2>/dev/null

  success "System dependencies installed."
}

# ─── install node.js ──────────────────────────────────────────────

install_node() {
  if command -v node &>/dev/null; then
    CURRENT_NODE=$(node --version | grep -oP '\d+' | head -1)
    if [[ "$CURRENT_NODE" -ge "$NODE_VERSION" ]]; then
      success "Node.js v$(node --version) already installed."
      return
    fi
    warn "Node.js $CURRENT_NODE is too old (need $NODE_VERSION+). Upgrading..."
  fi

  info "Installing Node.js $NODE_VERSION via NodeSource..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash - 2>/dev/null
  apt-get install -y -qq nodejs
  success "Node.js $(node --version) installed."
}

# ─── install pnpm ─────────────────────────────────────────────────

install_pnpm() {
  if command -v pnpm &>/dev/null; then
    success "pnpm $(pnpm --version) already installed."
    return
  fi

  info "Installing pnpm..."
  npm install -g "pnpm@$PNPM_VERSION" --quiet
  success "pnpm $(pnpm --version) installed."
}

# ─── install postgresql ───────────────────────────────────────────

install_postgres() {
  if command -v psql &>/dev/null; then
    success "PostgreSQL already installed."
  else
    info "Installing PostgreSQL..."
    apt-get install -y -qq postgresql postgresql-contrib
    systemctl enable postgresql --quiet
    systemctl start postgresql
    success "PostgreSQL installed and started."
  fi

  # Ensure postgres service is running
  if ! systemctl is-active --quiet postgresql; then
    systemctl start postgresql
  fi
}

# ─── set up database ──────────────────────────────────────────────

setup_database() {
  info "Setting up PostgreSQL database..."

  # Create user if not exists
  if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
    warn "DB user '$DB_USER' already exists. Skipping creation."
  else
    sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';" 2>/dev/null
    success "DB user '$DB_USER' created."
  fi

  # Create database if not exists
  if sudo -u postgres psql -lqt | cut -d \| -f 1 | grep -qw "$DB_NAME"; then
    warn "Database '$DB_NAME' already exists. Skipping creation."
  else
    sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;" 2>/dev/null
    success "Database '$DB_NAME' created."
  fi

  # Grant all privileges
  sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;" 2>/dev/null
  sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL ON SCHEMA public TO $DB_USER;" 2>/dev/null

  DATABASE_URL="postgresql://$DB_USER:$DB_PASS@localhost:5432/$DB_NAME"
  success "Database ready."
}

# ─── clone / update repo ──────────────────────────────────────────

clone_repo() {
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    info "Repository already exists. Pulling latest changes..."
    cd "$INSTALL_DIR"
    git pull origin main 2>/dev/null || warn "Could not pull latest. Continuing with existing code."
  else
    info "Cloning GunpointBots from GitHub..."
    git clone "$REPO_URL" "$INSTALL_DIR" 2>/dev/null || \
      error "Failed to clone repository. Check your internet connection and that $REPO_URL is accessible."
  fi

  success "Repository ready at $INSTALL_DIR."
}

# ─── write env file ───────────────────────────────────────────────

write_env() {
  cat > "$INSTALL_DIR/.env" <<EOF
DATABASE_URL=$DATABASE_URL
SESSION_SECRET=$SESSION_SECRET
PORT=$APP_PORT
NODE_ENV=production
EOF
  chmod 600 "$INSTALL_DIR/.env"
  success ".env file written."
}

# ─── install npm deps ─────────────────────────────────────────────

install_deps() {
  info "Installing npm dependencies (this may take a minute)..."
  cd "$INSTALL_DIR"

  # Ensure .npmrc doesn't block install
  export PNPM_HOME="/root/.local/share/pnpm"
  export PATH="$PNPM_HOME:$PATH"

  pnpm install --frozen-lockfile 2>/dev/null || pnpm install --no-frozen-lockfile
  success "Dependencies installed."
}

# ─── push db schema ───────────────────────────────────────────────

push_schema() {
  info "Pushing database schema..."
  cd "$INSTALL_DIR"
  export DATABASE_URL
  pnpm --filter @workspace/db run push 2>/dev/null || \
    error "Database schema push failed. Check your DATABASE_URL and PostgreSQL is running."
  success "Database schema ready."
}

# ─── build the app ────────────────────────────────────────────────

build_app() {
  info "Building the panel..."
  cd "$INSTALL_DIR"
  pnpm --filter @workspace/api-server run build 2>/dev/null || \
    error "Build failed. Check the logs above for TypeScript errors."
  success "Build complete."
}

# ─── create admin user ────────────────────────────────────────────

create_admin() {
  if [[ ! "$CREATE_ADMIN" =~ ^[Yy]$ ]]; then
    return
  fi

  info "Creating admin account '$ADMIN_USER'..."

  # Use node to hash the password and insert into DB
  node - <<NODEEOF
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: '$DATABASE_URL' });

async function main() {
  const hash = await bcrypt.hash('$ADMIN_PASS', 12);
  const client = await pool.connect();
  try {
    const exists = await client.query("SELECT id FROM users WHERE username = \$1", ['$ADMIN_USER']);
    if (exists.rows.length > 0) {
      await client.query(
        "UPDATE users SET password_hash = \$1, role = 'admin' WHERE username = \$2",
        [hash, '$ADMIN_USER']
      );
      console.log('Admin user updated.');
    } else {
      await client.query(
        "INSERT INTO users (username, password_hash, role) VALUES (\$1, \$2, 'admin')",
        ['$ADMIN_USER', hash]
      );
      console.log('Admin user created.');
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error('Admin creation failed:', err.message); process.exit(1); });
NODEEOF

  success "Admin account '$ADMIN_USER' ready."
}

# ─── create systemd service ───────────────────────────────────────

setup_service() {
  info "Setting up systemd service..."

  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=GunpointBots Panel
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR/artifacts/api-server
ExecStart=/usr/bin/node --enable-source-maps $INSTALL_DIR/artifacts/api-server/dist/index.mjs
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=$APP_PORT
EnvironmentFile=$INSTALL_DIR/.env
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SERVICE_NAME

# Security hardening
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" --quiet
  systemctl restart "$SERVICE_NAME"

  # Wait and check
  sleep 2
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    success "Service '$SERVICE_NAME' is running."
  else
    warn "Service may have failed to start. Check: journalctl -u $SERVICE_NAME -n 30"
  fi
}

# ─── set up nginx ─────────────────────────────────────────────────

setup_nginx() {
  if [[ ! "$SETUP_NGINX" =~ ^[Yy]$ ]]; then
    return
  fi

  info "Setting up Nginx..."
  apt-get install -y -qq nginx

  cat > "/etc/nginx/sites-available/$SERVICE_NAME" <<EOF
server {
    listen 80;
    server_name $DOMAIN_NAME;

    client_max_body_size 100M;

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
    }
}
EOF

  # Enable site
  ln -sf "/etc/nginx/sites-available/$SERVICE_NAME" "/etc/nginx/sites-enabled/"
  nginx -t 2>/dev/null && systemctl reload nginx
  success "Nginx configured for $DOMAIN_NAME → localhost:$APP_PORT"

  # Optionally set up SSL with certbot
  ask "  Install SSL certificate with Let's Encrypt? [y/N]:"
  read -r SETUP_SSL
  SETUP_SSL="${SETUP_SSL:-N}"
  if [[ "$SETUP_SSL" =~ ^[Yy]$ ]]; then
    apt-get install -y -qq certbot python3-certbot-nginx
    certbot --nginx -d "$DOMAIN_NAME" --non-interactive --agree-tos \
      --register-unsafely-without-email 2>/dev/null || \
      warn "Certbot failed. Set up SSL manually later."
  fi
}

# ─── open firewall port ───────────────────────────────────────────

open_firewall() {
  if command -v ufw &>/dev/null && ufw status | grep -q "Status: active"; then
    info "Opening firewall port $APP_PORT..."
    ufw allow "$APP_PORT/tcp" --quiet 2>/dev/null || true
    if [[ "$SETUP_NGINX" =~ ^[Yy]$ ]]; then
      ufw allow "Nginx Full" --quiet 2>/dev/null || true
    fi
    success "Firewall updated."
  fi
}

# ─── print summary ────────────────────────────────────────────────

print_summary() {
  SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

  echo ""
  echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}${BOLD}  ✓ GunpointBots Panel installed successfully!${NC}"
  echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""

  if [[ "$SETUP_NGINX" =~ ^[Yy]$ ]]; then
    echo -e "  ${BOLD}Panel URL:${NC}   http://$DOMAIN_NAME"
  else
    echo -e "  ${BOLD}Panel URL:${NC}   http://$SERVER_IP:$APP_PORT"
  fi

  echo -e "  ${BOLD}API Base:${NC}    http://$SERVER_IP:$APP_PORT/api"
  echo -e "  ${BOLD}Health:${NC}      http://$SERVER_IP:$APP_PORT/api/healthz"
  echo ""

  if [[ "$CREATE_ADMIN" =~ ^[Yy]$ ]]; then
    echo -e "  ${BOLD}Admin user:${NC}  $ADMIN_USER"
    echo -e "  ${BOLD}Admin pass:${NC}  (what you entered)"
  fi

  echo ""
  echo -e "  ${BOLD}Useful commands:${NC}"
  echo -e "  ${CYAN}systemctl status $SERVICE_NAME${NC}     — check status"
  echo -e "  ${CYAN}systemctl restart $SERVICE_NAME${NC}    — restart panel"
  echo -e "  ${CYAN}journalctl -u $SERVICE_NAME -f${NC}     — live logs"
  echo -e "  ${CYAN}systemctl stop $SERVICE_NAME${NC}       — stop panel"
  echo ""
  echo -e "  ${BOLD}Install dir:${NC} $INSTALL_DIR"
  echo -e "  ${BOLD}Env file:${NC}    $INSTALL_DIR/.env"
  echo ""
  echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
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
  setup_service
  open_firewall
  setup_nginx

  print_summary
}

main "$@"
