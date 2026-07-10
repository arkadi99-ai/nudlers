# =============================================================================
# Stage 1: Dependencies
# =============================================================================
FROM node:22-bookworm-slim AS deps

WORKDIR /app

# Prevent Puppeteer from downloading Chromium during npm install
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Copy only package files for better layer caching
COPY package.json package-lock.json* yarn.lock* ./
COPY patches* ./patches/

# Install dependencies
RUN npm ci

# =============================================================================
# Stage 2: Builder
# =============================================================================
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build the application
# Give the build enough heap space (NAS devices may have limited RAM)
ENV NEXT_TELEMETRY_DISABLED=1 \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    NODE_OPTIONS="--max-old-space-size=1536"
RUN npm run build

# =============================================================================
# Stage 3: Runner
# =============================================================================
# Use a slim Node image and install ONLY the required system dependencies for Chromium
FROM node:22-bookworm-slim AS runner

WORKDIR /app

# Chrome for Testing version — MUST match the browser pinned by our puppeteer version
# (see node_modules/puppeteer-core/lib/cjs/puppeteer/revisions.js for puppeteer 24.40.0).
# On amd64 we use Google's pinned build instead of Debian's `chromium` package because the
# Debian build drifts to a new version on every image rebuild, and newer builds crash on
# launch (SIGTRAP / "Failed to launch the browser process: Code: null") in some virtualized
# environments (see #120). Google does not publish linux/arm64 builds, so arm64 keeps the
# Debian package (which does not exhibit the crash).
ARG CHROME_VERSION=146.0.7680.153

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME="0.0.0.0" \
    LOW_RESOURCES_MODE=true \
    PUPPETEER_EXECUTABLE_PATH="/usr/bin/chromium" \
    # Limit Node.js heap to 768MB for NAS (override with NODE_OPTIONS env var if needed)
    NODE_OPTIONS="--max-old-space-size=768" \
    # Reduce logging verbosity for NAS
    LOG_LEVEL=warn

# 1. Install Chromium runtime dependencies + Xvfb + Tini + gosu (for privilege dropping)
# (the browser itself is Google's pinned Chrome for Testing, installed in step 1b)
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-liberation \
    fonts-noto-core \
    fonts-noto-ui-core \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    xvfb \
    tini \
    gosu \
    && rm -rf /var/lib/apt/lists/*

# 1b. Install the browser behind /usr/bin/chromium (see CHROME_VERSION comment above):
#     amd64 → Google's pinned Chrome for Testing; arm64 → Debian chromium package
RUN ARCH="$(dpkg --print-architecture)" \
    && if [ "$ARCH" = "amd64" ]; then \
    apt-get update && apt-get install -y --no-install-recommends unzip \
    && npx -y @puppeteer/browsers install chrome@${CHROME_VERSION} --path /opt/chrome \
    && ln -sf "/opt/chrome/chrome/linux-${CHROME_VERSION}/chrome-linux64/chrome" /usr/bin/chromium \
    && chmod -R a+rX /opt/chrome \
    && apt-get purge -y unzip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* /root/.npm; \
    else \
    apt-get update && apt-get install -y --no-install-recommends chromium \
    && rm -rf /var/lib/apt/lists/*; \
    fi

# 2. Setup non-root user for running the app
# Handle case where GID/UID might already exist in base image
RUN (getent group pptruser || groupadd -r pptruser) \
    && (getent passwd pptruser || useradd -r -g pptruser -G audio,video -m pptruser) \
    && mkdir -p /home/pptruser/Downloads /app/.baileys_auth \
    && chown -R pptruser:pptruser /home/pptruser \
    && chown -R pptruser:pptruser /app

# 3. Copy standalone build and necessary assets
# standalone mode includes server.js and a minimal node_modules
COPY --from=builder --chown=pptruser:pptruser /app/.next/standalone ./
COPY --from=builder --chown=pptruser:pptruser /app/.next/static ./.next/static
COPY --from=builder --chown=pptruser:pptruser /app/public ./public

# Copy scraper-related files (not always fully traced by Next.js standalone)
COPY --from=builder --chown=pptruser:pptruser /app/scrapers ./scrapers
COPY --from=builder --chown=pptruser:pptruser /app/utils ./utils
COPY --from=builder --chown=pptruser:pptruser /app/pages ./pages
COPY --chown=pptruser:pptruser scripts ./scripts

RUN chmod +x /app/scripts/start.sh

# Note: We don't set USER here - the container starts as root to fix volume permissions,
# then start.sh drops privileges to pptruser via gosu. This is the standard pattern
# used by official images (postgres, mysql, redis, etc.)

EXPOSE 3000

# Use tini as the entrypoint to handle signals and zombie processes
ENTRYPOINT ["/usr/bin/tini", "--"]

CMD ["/app/scripts/start.sh"]
