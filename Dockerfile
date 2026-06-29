FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npx tsc

COPY tokens.json ./

RUN npm prune --omit=dev

EXPOSE 9191

CMD ["node", "dist/server.js"]
