FROM node:22-alpine

WORKDIR /app

# Install deps first so a code-only change reuses the cached layer.
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/http.js"]
