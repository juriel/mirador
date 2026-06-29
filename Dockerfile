FROM mcr.microsoft.com/playwright:v1.50.0-noble

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npx tsc

COPY tokens.json ./

RUN npm prune --omit=dev

EXPOSE 9191

CMD ["node", "dist/server.js"]
