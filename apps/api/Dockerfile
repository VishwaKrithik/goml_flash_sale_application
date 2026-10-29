FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build
# Ensure the non-ts Lua file is present in the build output
RUN mkdir -p dist/lua && cp src/lua/reserve_stock.lua dist/lua/

ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/index.js"]