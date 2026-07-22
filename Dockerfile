FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Build the React frontend (served at /app). Unconditional on purpose: if
# this fails, the whole deploy should fail loudly, not silently fall back
# to legacy-only. frontend/ is now a permanent part of this repo.
RUN cd frontend && npm install && npm run build

ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/server.js"]
