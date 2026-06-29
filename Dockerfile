FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install

COPY src/ ./src/
RUN npm run build

EXPOSE 9191

CMD ["node", "dist/server.js"]
