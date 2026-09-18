# Playwright's official image ships Chromium plus every shared library it needs
# (libnss3, libatk, libgbm, fonts…). Render's native Node runtime does not, and
# `playwright install --with-deps` cannot add them there because the build step
# has no root. Using this image is the reliable way to run a browser on Render.
#
# The tag MUST match the playwright version in package.json.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app

# Install dependencies first so Docker caches this layer between code changes.
# The browsers are already in the base image, so skip the postinstall download.
COPY package*.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --ignore-scripts --omit=dev

COPY . .

ENV NODE_ENV=production
# Render injects PORT at runtime; this is only the documented default.
EXPOSE 8080

# Run as the non-root user the base image provides.
USER pwuser

CMD ["node", "src/server.js"]
