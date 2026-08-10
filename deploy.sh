#!/usr/bin/env bash
# ============================================================================
# pixiv-viewer — server/deploy.sh
#
# Bare-metal deployment for the manga-translation server. Tested on Ubuntu
# 22.04/24.04 (apt) and AlmaLinux/RHEL-family (dnf); glibc only —
# onnxruntime-node/canvas do NOT support musl/Alpine.
#
# Package manager is auto-detected: `dnf` -> AlmaLinux/RHEL path,
# `apt-get` -> Ubuntu path.
#
# Steps:
#   1. system packages (dnf on AlmaLinux/RHEL, apt on Ubuntu):
#      libgomp + node-canvas deps + compiler/curl (package lists below)
#   2. Node.js >= 20 (existing install kept; else installed via nvm)
#   3. CJK fonts (fonts-noto-cjk via apt / google-noto-sans-cjk-fonts via dnf,
#      else SourceHanSans download)
#   4. ONNX models -> server/models/ (sha256-verified, manifest-driven)
#   5. server/.env from .env.example (interactive fill when a TTY)
#   6. Startup instructions (does NOT auto-start the service)
#
# Idempotent: every step guards on "already done"; safe to re-run.
#
# Override env vars (all optional):
#   DEPLOY_SKIP_APT=1          skip package installation entirely (offline/QA/CI)
#   DEPLOY_SKIP_NODE=1         don't auto-install Node (fail if missing)
#   DEPLOY_NONINTERACTIVE=1    don't prompt for .env values
#   MODELS_DIR                  models dir override (same env as the runtime:
#                               absolute passes through, relative resolves
#                               against the server root; default server/models)
#   MODEL_MANIFEST_URL          manifest URL for the self-contained CDN path
#                               (default derived from VUE_APP_MODEL_RELEASE_TAG)
#   MODEL_SOURCE_DIR            optional source dir to copy models + models.json
#                               from first (sha256-verified) — e.g. a
#                               pixiv-viewer checkout: MODEL_SOURCE_DIR="$PWD/public/models"
#   VUE_APP_MODEL_RELEASE_TAG   GitHub Releases CDN tag (default models-v0.7.0,
#                               see $DEFAULT_MODEL_RELEASE_TAG)
#   VUE_APP_MODEL_URL_TEMPLATE  custom CDN URL template with {filename}
#   DEPLOY_SOURCE_HAN_URL       custom SourceHanSans font URL (fallback path)
#
# Notes:
#   - AlmaLinux/RHEL: the server runs `node --env-file-if-exists=.env`, which
#     needs Node >= 20.12. The nvm path installs current Node LTS, so this is
#     satisfied automatically.
#   - If the node-canvas native build fails on RHEL, install these optional deps
#     (documented note only — NOT auto-installed by this script):
#       dnf install -y libpng-devel freetype-devel pixman-devel
#
# Model resolution (self-contained — the server reads ONLY server/models/):
#   manifest source (in priority order):
#     1. already present at $MODELS_DIR/models.json       (idempotency)
#     2. $MODEL_SOURCE_DIR/models.json                    (checkout convenience)
#     3. $MODEL_MANIFEST_URL                               (CDN, default derived from
#        VUE_APP_MODEL_RELEASE_TAG → ShinobuTranslator public/models/models.json;
#        tag defaults to models-v0.7.0 when unset)
#   per-model file source (mirrors src/utils/translate/shinobu/runtime/
#   modelRegistry.js `resolveModelUrl`):
#     1. already present + sha256-verified                 (idempotency)
#     2. $MODEL_SOURCE_DIR/<file>                          (checkout convenience)
#     3. VUE_APP_MODEL_URL_TEMPLATE                        ({filename} placeholder)
#     4. VUE_APP_MODEL_RELEASE_TAG                         (ShinobuTranslator release asset,
#        default models-v0.7.0)
#     5. (none of the above)                               -> error with guidance
# ============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Config (env overridable)
# ---------------------------------------------------------------------------
DEPLOY_SKIP_APT="${DEPLOY_SKIP_APT:-0}"
DEPLOY_SKIP_NODE="${DEPLOY_SKIP_NODE:-0}"
DEPLOY_NONINTERACTIVE="${DEPLOY_NONINTERACTIVE:-0}"

NODE_MAJOR_MIN=20

# Model CDN defaults — a sensible release tag ships with the script so a bare
# `bash server/deploy.sh` with NO env vars still resolves the manifest + model
# download URLs out-of-the-box (matching the project .env.example suggestion).
DEFAULT_MODEL_RELEASE_TAG="${DEFAULT_MODEL_RELEASE_TAG:-models-v0.7.0}"
VUE_APP_MODEL_RELEASE_TAG="${VUE_APP_MODEL_RELEASE_TAG:-$DEFAULT_MODEL_RELEASE_TAG}"

# ---------------------------------------------------------------------------
# Paths (everything resolves under the server dir — self-contained deploy:
# copy server/ alone and it works, no repo-root anchoring, no public/models)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$SCRIPT_DIR"

# MODELS_DIR honors the same env override as the runtime
# (server/src/util/paths.js): absolute passes through, relative resolves
# against the server root; default <script-dir>/models.
if [ -n "${MODELS_DIR:-}" ]; then
  case "$MODELS_DIR" in
    /*) MODELS_DIR="$MODELS_DIR" ;;
    *) MODELS_DIR="$SERVER_DIR/$MODELS_DIR" ;;
  esac
else
  MODELS_DIR="$SERVER_DIR/models"
fi

FONTS_DIR="$SERVER_DIR/fonts"

# Optional convenience: copy models + models.json from a source directory
# first (sha256-verified). E.g. a pixiv-viewer checkout:
#   MODEL_SOURCE_DIR="$PWD/public/models" bash server/deploy.sh
# NOT a default — the server is self-contained via the CDN path below.
MODEL_SOURCE_DIR="${MODEL_SOURCE_DIR:-}"

# Manifest source for the self-contained CDN path. Default derived from
# VUE_APP_MODEL_RELEASE_TAG (itself defaulting to $DEFAULT_MODEL_RELEASE_TAG
# above) — the ShinobuTranslator repo serves its manifest at
# public/models/models.json on release tags. Empty → error with guidance.
if [ -n "${MODEL_MANIFEST_URL:-}" ]; then
  MODEL_MANIFEST_URL="$MODEL_MANIFEST_URL"
elif [ -n "${VUE_APP_MODEL_RELEASE_TAG:-}" ]; then
  MODEL_MANIFEST_URL="https://raw.githubusercontent.com/DonutShinobu/ShinobuTranslator/${VUE_APP_MODEL_RELEASE_TAG}/public/models/models.json"
else
  # Safety net: VUE_APP_MODEL_RELEASE_TAG is defaulted above, so this arm is
  # normally unreachable — kept only if someone clears the variable later.
  MODEL_MANIFEST_URL=""
fi

MANIFEST="$MODELS_DIR/models.json"
ENV_EXAMPLE="$SERVER_DIR/.env.example"
ENV_FILE="$SERVER_DIR/.env"

SOURCE_HAN_SANS_URL="${DEPLOY_SOURCE_HAN_URL:-https://github.com/adobe-fonts/source-han-sans/raw/release/OTF/SimplifiedChinese/SourceHanSansSC-Regular.otf}"

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
C_BOLD=$'\033[1m'
C_GREEN=$'\033[32m'
C_YELLOW=$'\033[33m'
C_RED=$'\033[31m'
C_RESET=$'\033[0m'

info() { printf '%s==>%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
step() { printf '\n%s== [%s] %s%s\n' "$C_BOLD" "$(date +%H:%M:%S)" "$C_RESET" "$*"; }
skip() { printf '%s-- %s%s\n' "$C_YELLOW" "$*" "$C_RESET"; }
warn() { printf '%s!! %s%s\n' "$C_YELLOW" "$*" "$C_RESET"; }
die()  { printf '%sERROR: %s%s\n' "$C_RED" "$*" "$C_RESET" >&2; exit 1; }

# sudo when not root
SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi

# ---------------------------------------------------------------------------
# Common helpers
# ---------------------------------------------------------------------------

# sha256 of a file, lowercased ("" on failure)
sha256_of() { sha256sum "$1" 2>/dev/null | awk '{print $1}'; }

verify_sha256() { # file expected_hash -> 0 if match
  local file="$1" expected="$2"
  [ -n "$expected" ] || return 1
  [ -f "$file" ] || return 1
  [ "$(sha256_of "$file")" = "$expected" ]
}

# Atomic download (tmp + rename): curl preferred, wget fallback
download_to() { # url dest
  local url="$1" dest="$2"
  mkdir -p "$(dirname -- "$dest")"
  local tmp="$dest.tmp.$$"
  trap 'rm -f "$tmp"' EXIT
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 -o "$tmp" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --tries=3 --timeout=40 -O "$tmp" "$url"
  else
    die "neither curl nor wget found — install one (curl) first"
  fi
  mv "$tmp" "$dest"
  trap - EXIT
}

# ---------------------------------------------------------------------------
# Step 1/6 — system packages (apt on Ubuntu / dnf on AlmaLinux-RHEL)
# ---------------------------------------------------------------------------
detect_pkg_mgr() { # -> dnf | apt | unknown
  if command -v dnf >/dev/null 2>&1; then
    echo dnf
  elif command -v apt-get >/dev/null 2>&1; then
    echo apt
  else
    echo unknown
  fi
}

pkg_installed() { # pkg -> 0 if installed (dnf: rpm -q, apt: dpkg -s)
  if [ "$PKG_MGR" = dnf ]; then
    rpm -q "$1" >/dev/null 2>&1
  else
    dpkg -s "$1" >/dev/null 2>&1
  fi
}

pkg_install() { # pkgs...
  if [ "$PKG_MGR" = dnf ]; then
    $SUDO dnf install -y "$@"
  else
    $SUDO apt-get install -y --no-install-recommends "$@"
  fi
}

system_packages() {
  PKG_MGR="$(detect_pkg_mgr)"
  step "Step 1/6: System packages ($PKG_MGR)"

  if [ "$DEPLOY_SKIP_APT" = "1" ]; then
    skip "DEPLOY_SKIP_APT=1 — package installation skipped (install the packages manually if needed)"
    return 0
  fi

  if [ "$PKG_MGR" = unknown ]; then
    die "no supported package manager found (neither dnf nor apt-get). Install one, or set DEPLOY_SKIP_APT=1."
  fi

  if [ "$(id -u)" -ne 0 ] && ! command -v sudo >/dev/null 2>&1; then
    die "$PKG_MGR install needs root (run as root, install sudo, or set DEPLOY_SKIP_APT=1)"
  fi

  local pkgs
  if [ "$PKG_MGR" = dnf ]; then
    pkgs=(
      libgomp                               # onnxruntime-node CPU EP (OpenMP)
      cairo-devel pango-devel               # node-canvas
      libjpeg-turbo-devel giflib-devel librsvg2-devel  # node-canvas image formats
      gcc-c++ make                          # native addons may need a compiler
      curl ca-certificates fontconfig       # script prerequisites (HTTPS downloads)
    )
    # node-canvas native build failing on RHEL? Install optional deps:
    #   dnf install -y libpng-devel freetype-devel pixman-devel
    # (documented note only — NOT auto-installed)
  else
    pkgs=(
      libgomp1                              # onnxruntime-node CPU EP (OpenMP)
      libcairo2-dev libpango1.0-dev         # node-canvas
      libjpeg-dev libgif-dev librsvg2-dev   # node-canvas image formats
      build-essential                       # native addons may need a compiler
      curl ca-certificates                  # script prerequisites (HTTPS downloads)
    )
  fi

  # Idempotent: only install packages that are missing
  local missing=()
  local pkg
  for pkg in "${pkgs[@]}"; do
    if ! pkg_installed "$pkg"; then
      missing+=("$pkg")
    fi
  done

  if [ "${#missing[@]}" -eq 0 ]; then
    skip "all $PKG_MGR packages already installed"
    return 0
  fi

  info "installing: ${missing[*]}"
  if [ "$PKG_MGR" = apt ]; then
    $SUDO apt-get update -qq
  fi
  pkg_install "${missing[@]}"
}

# ---------------------------------------------------------------------------
# Step 2/6 — Node.js >= 20
# ---------------------------------------------------------------------------
node_major() { node --version 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\).*/\1/p'; }

node_satisfied() {
  local v
  v="$(node_major)"
  [ -n "$v" ] && [ "$v" -ge "$NODE_MAJOR_MIN" ]
}

install_node() {
  step "Step 2/6: Node.js >= $NODE_MAJOR_MIN"

  if node_satisfied; then
    skip "Node $(node --version) already installed and >= $NODE_MAJOR_MIN"
    return 0
  fi

  if [ "$DEPLOY_SKIP_NODE" = "1" ]; then
    die "Node.js >= $NODE_MAJOR_MIN required but not found (DEPLOY_SKIP_NODE=1). Install Node 20+ and re-run."
  fi
  command -v curl >/dev/null 2>&1 || die "curl required to install Node via nvm"

  # nvm chosen over apt: installs a current Node 20+ LTS per-user without
  # depending on the distro's stale nodejs package, and avoids sudo for Node.
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    info "installing nvm to $NVM_DIR ..."
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  fi
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  info "installing latest Node LTS via nvm ..."
  nvm install --lts
  nvm alias default 'lts/*'
  nvm use default >/dev/null
  info "Node $(node --version) installed. A new login shell is required for PATH updates."
}

# ---------------------------------------------------------------------------
# Step 3/6 — CJK fonts (node-canvas typesetting needs TTF/OTF, NOT woff2)
# ---------------------------------------------------------------------------
has_cjk_font() { fc-list 2>/dev/null | grep -qiE 'cjk|wenkai|han'; }

install_source_han_sans() {
  mkdir -p "$FONTS_DIR"
  local dest="$FONTS_DIR/SourceHanSansSC-Regular.otf"

  if [ -s "$dest" ]; then
    skip "SourceHanSans already present at $dest"
  else
    info "downloading SourceHanSans (OTF — node-canvas compatible) ..."
    download_to "$SOURCE_HAN_SANS_URL" "$dest" || die "font download failed: $SOURCE_HAN_SANS_URL"
  fi

  # Register with fontconfig so fc-list (and the server) can find it.
  local font_target
  if [ "$(id -u)" -eq 0 ]; then
    font_target="/usr/local/share/fonts"
  else
    font_target="$HOME/.local/share/fonts"
  fi
  mkdir -p "$font_target"
  if [ ! -e "$font_target/$(basename -- "$dest")" ]; then
    cp "$dest" "$font_target/"
  fi
  fc-cache -f "$font_target" >/dev/null 2>&1 || fc-cache -f >/dev/null 2>&1 || true

  if has_cjk_font; then
    info "CJK font registered — fc-list can now find it"
  else
    warn "font downloaded but not yet visible to fc-list — run: fc-cache -f"
  fi
}

install_cjk_fonts() {
  step "Step 3/6: CJK fonts (node-canvas typesetting)"

  if has_cjk_font; then
    skip "a CJK font is already available via fontconfig"
    return 0
  fi

  # Preferred: distro CJK font package (fonts-noto-cjk via apt,
  # google-noto-sans-cjk-fonts via dnf)
  if [ "$DEPLOY_SKIP_APT" != "1" ] && { [ "$(id -u)" -eq 0 ] || command -v sudo >/dev/null 2>&1; }; then
    local font_pkg="fonts-noto-cjk"
    if [ "$PKG_MGR" = dnf ]; then
      font_pkg="google-noto-sans-cjk-fonts"
    fi
    if ! pkg_installed "$font_pkg"; then
      info "installing $font_pkg ..."
      pkg_install "$font_pkg" >/dev/null 2>&1 \
        || warn "$font_pkg install failed — trying download fallback"
    fi
    fc-cache -f >/dev/null 2>&1 || true
    if has_cjk_font; then
      info "$font_pkg installed and detected"
      return 0
    fi
  elif [ "$DEPLOY_SKIP_APT" = "1" ]; then
    skip "DEPLOY_SKIP_APT=1 — distro font package skipped, using download fallback"
  fi

  # Fallback: SourceHanSans to server/fonts/
  install_source_han_sans
}

# ---------------------------------------------------------------------------
# Step 4/6 — ONNX models -> server/models/
# ---------------------------------------------------------------------------
# CDN URL resolution — mirrors modelRegistry.js resolveModelUrl()
resolve_model_url() { # filename
  local filename="$1"
  if [ -n "${VUE_APP_MODEL_URL_TEMPLATE:-}" ]; then
    echo "${VUE_APP_MODEL_URL_TEMPLATE//\{filename\}/$filename}"
    return 0
  fi
  if [ -n "${VUE_APP_MODEL_RELEASE_TAG:-}" ]; then
    echo "https://github.com/DonutShinobu/ShinobuTranslator/releases/download/${VUE_APP_MODEL_RELEASE_TAG}/${filename}"
    return 0
  fi
  echo ""
}

ensure_model_file() { # dest sha256 local_src
  local dest="$1" sha="$2" local_src="$3"
  local name
  name="$(basename -- "$dest")"

  if [ -n "$sha" ]; then
    # Already present and verified -> skip (idempotency)
    if [ -f "$dest" ] && verify_sha256 "$dest" "$sha"; then
      skip "OK   $name (sha256 verified)"
      return 0
    fi
    if [ -f "$dest" ]; then
      warn "sha256 mismatch on existing $name — re-acquiring"
      rm -f "$dest"
    fi
  elif [ -f "$dest" ]; then
    # Manifest carries no sha256 — presence is the best we can assert
    skip "OK   $name (present; manifest has no sha256 to verify)"
    return 0
  fi

  # Fast path: copy from MODEL_SOURCE_DIR (e.g. a checkout's public/models)
  if [ -n "$local_src" ] && [ -f "$local_src" ]; then
    if [ -z "$sha" ] || verify_sha256 "$local_src" "$sha"; then
      cp "$local_src" "$dest"
      info "copied $name from $MODEL_SOURCE_DIR"
      return 0
    fi
    warn "local copy ${local_src##*/} sha256 mismatch — ignoring"
  fi

  # CDN path (template > release tag)
  local url
  url="$(resolve_model_url "$name")"
  if [ -z "$url" ]; then
    die "no verified local copy and no CDN configured for $name. Set VUE_APP_MODEL_RELEASE_TAG or VUE_APP_MODEL_URL_TEMPLATE, or set MODEL_SOURCE_DIR to a directory containing the models + models.json (e.g. a pixiv-viewer checkout's public/models)."
  fi
  info "downloading $name from $url"
  download_to "$url" "$dest"
  if [ -n "$sha" ] && ! verify_sha256 "$dest" "$sha"; then
    rm -f "$dest"
    die "sha256 verification failed for $name (from $url)"
  fi
  info "downloaded $name ($([ -n "$sha" ] && echo 'sha256 verified' || echo 'no sha256 in manifest — verification skipped'))"
}

# Place the model manifest at $MODELS_DIR/models.json.
ensure_manifest() { # dest
  local dest="$1"
  if [ -f "$dest" ]; then
    skip "model manifest already present at $dest"
    return 0
  fi
  # Convenience: copy the manifest from MODEL_SOURCE_DIR (a checkout)
  if [ -n "$MODEL_SOURCE_DIR" ] && [ -f "$MODEL_SOURCE_DIR/models.json" ]; then
    cp "$MODEL_SOURCE_DIR/models.json" "$dest"
    info "copied manifest from $MODEL_SOURCE_DIR/models.json"
    return 0
  fi
  # Self-contained: download the manifest from CDN
  if [ -n "$MODEL_MANIFEST_URL" ]; then
    info "downloading manifest from $MODEL_MANIFEST_URL"
    download_to "$MODEL_MANIFEST_URL" "$dest" || die "manifest download failed: $MODEL_MANIFEST_URL"
    return 0
  fi
  die "no model manifest source: set MODEL_SOURCE_DIR (a pixiv-viewer checkout's public/models), MODEL_MANIFEST_URL, or VUE_APP_MODEL_RELEASE_TAG."
}

# Emit "filename sha256" lines for every manifest model + OCR dict
load_manifest_files() {
  python3 - "$MANIFEST" <<'PY'
import json, sys
m = json.load(open(sys.argv[1], encoding="utf-8"))
names = m.get("modelOrder") or list(m["models"].keys())
for key in names:
    mod = m["models"][key]
    if mod.get("url"):
        print(mod["url"].split("/")[-1], mod.get("sha256", ""))
    if mod.get("dictUrl"):
        print(mod["dictUrl"].split("/")[-1], mod.get("dictSha256", ""))
PY
}

sync_models() {
  step "Step 4/6: ONNX models -> $MODELS_DIR"

  command -v python3 >/dev/null 2>&1 || die "python3 required to parse models.json"
  mkdir -p "$MODELS_DIR"
  ensure_manifest "$MANIFEST"
  [ -f "$MANIFEST" ] || die "model manifest not found: $MANIFEST"

  local count=0
  local fname sha local_src
  while read -r fname sha; do
    [ -n "$fname" ] || continue
    local_src=""
    if [ -n "$MODEL_SOURCE_DIR" ]; then
      local_src="$MODEL_SOURCE_DIR/$fname"
    fi
    ensure_model_file "$MODELS_DIR/$fname" "$sha" "$local_src"
    count=$((count + 1))
  done < <(load_manifest_files)

  info "model sync complete ($count file(s) ensured)"

  local onnx_count
  onnx_count="$(find "$MODELS_DIR" -maxdepth 1 -name '*.onnx' -size +1M 2>/dev/null | wc -l)"
  if [ "$onnx_count" -lt 4 ]; then
    warn "expected 4 non-empty ONNX models, found $onnx_count in $MODELS_DIR"
  fi
}

# ---------------------------------------------------------------------------
# Step 5/6 — server/.env
# ---------------------------------------------------------------------------
# Safe env key writer (special chars in values are preserved)
set_env_value() { # key value
  python3 - "$ENV_FILE" "$1" "$2" <<'PY'
import re, sys
path, key, val = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(path, encoding="utf-8").read().splitlines()
pat = re.compile(r"^#?\s*" + re.escape(key) + r"=")
out, replaced = [], False
for ln in lines:
    if pat.match(ln):
        out.append(f"{key}={val}"); replaced = True
    else:
        out.append(ln)
if not replaced:
    out.append(f"{key}={val}")
open(path, "w", encoding="utf-8").write("\n".join(out) + "\n")
PY
}

env_value() { # key
  grep -E "^${1}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true
}

prompt_env() { # key description
  local key="$1" desc="$2"
  local current val
  current="$(env_value "$key")"
  printf '  %s [%s]: ' "$desc" "$current"
  read -r val || true
  if [ -n "$val" ]; then
    set_env_value "$key" "$val"
    info "  $key set"
  else
    skip "  $key kept default"
  fi
}

setup_env() {
  step "Step 5/6: server/.env"

  if [ -f "$ENV_FILE" ]; then
    skip "$ENV_FILE already exists"
    return 0
  fi
  [ -f "$ENV_EXAMPLE" ] || die "template not found: $ENV_EXAMPLE"

  cp "$ENV_EXAMPLE" "$ENV_FILE"
  info "created $ENV_FILE from $ENV_EXAMPLE"

  if [ "$DEPLOY_NONINTERACTIVE" = "1" ] || [ ! -t 0 ]; then
    warn "non-interactive shell — edit $ENV_FILE manually (PORT / TOKEN / LLM_BASE_URL / LLM_API_KEY / IMAGE_PROXY)"
    return 0
  fi

  info "fill in the key values (enter keeps the default):"
  prompt_env PORT "HTTP listen port"
  prompt_env TOKEN "Bearer token (empty = open)"
  prompt_env LLM_API_KEY "LLM API key (e.g. SiliconCloud)"
  prompt_env IMAGE_PROXY "Image proxy prefix (optional)"
}

# ---------------------------------------------------------------------------
# Step 6/6 — startup instructions
# ---------------------------------------------------------------------------
print_instructions() {
  step "Step 6/6: Server ready — startup instructions"
  cat <<EOF

${C_BOLD}pixiv-viewer manga-translation server is prepared.${C_RESET}
The service is NOT started automatically.

  Install dependencies + start:
    cd $SERVER_DIR && npm install && npm start

  Configuration:
    $ENV_FILE   PORT / TOKEN / LLM_BASE_URL / LLM_API_KEY / LLM_MODEL / IMAGE_PROXY
    $MODELS_DIR 4 ONNX models + OCR dictionary (sha256-verified)
    CJK fonts   fontconfig (fonts-noto-cjk / google-noto-sans-cjk-fonts) or $FONTS_DIR

  Sanity checks:
    node --version                              # >= $NODE_MAJOR_MIN
    fc-list | grep -iE 'cjk|wenkai|han'         # CJK font present
    ls -la $MODELS_DIR                          # 4 non-empty .onnx

  API endpoint (once running):
    POST http://localhost:\${PORT:-3000}/translate
EOF
}

# ---------------------------------------------------------------------------
main() {
  system_packages
  install_node
  install_cjk_fonts
  sync_models
  setup_env
  print_instructions
  printf '\n%s== Deployment complete (exit 0)%s\n' "$C_GREEN" "$C_RESET"
}

main "$@"
