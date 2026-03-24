FROM node:20-slim

# Install build tools for better-sqlite3 + git for import-git tool
RUN apt-get update && apt-get install -y python3 make g++ git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --include=optional

COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

# Data volume
RUN mkdir -p /data

# Non-root user
RUN addgroup --system trapic && adduser --system --ingroup trapic trapic
RUN chown -R trapic:trapic /data /app
USER trapic

VOLUME /data

ENV TRAPIC_PORT=3000
ENV TRAPIC_HOST=0.0.0.0
ENV TRAPIC_DB=/data/trapic.db
ENV TRAPIC_USER="local-user"

EXPOSE 3000

CMD ["node", "dist/server.js"]
