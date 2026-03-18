FROM node:20-slim

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --production

# Copy built code and prompts
COPY dist/ ./dist/
COPY prompts/ ./prompts/

# Create data directory
RUN mkdir -p /app/data

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:3333/health || exit 1

EXPOSE 3333

CMD ["node", "dist/index.js"]
