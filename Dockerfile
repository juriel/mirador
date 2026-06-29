FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY dist/ ./dist/
COPY tokens.json ./

EXPOSE 9191

CMD ["node", "dist/server.js"]
