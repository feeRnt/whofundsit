# WhoFundsIt: single-origin deploy (Express serves frontend/dist).
#
# Build:  docker build -t whofundsit .
# Run:    docker run -e DATABASE_URL=... -e PORT=4000 -p 4000:4000 whofundsit
#
# Seed (one-time, from your laptop against the hosted DB — no dump upload):
#   DATABASE_URL=<hosted> npm --prefix backend run db:push
#   DATABASE_URL=<hosted> npm --prefix backend run db:seed

FROM node:22-slim AS build
WORKDIR /app
COPY backend/package*.json ./backend/
COPY frontend/package*.json ./frontend/
RUN npm --prefix backend ci && npm --prefix frontend ci
COPY backend/prisma ./backend/prisma
RUN npm --prefix backend run db:generate
COPY backend ./backend
COPY frontend ./frontend
RUN npm --prefix backend run build
RUN npm --prefix frontend run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/backend/package*.json ./backend/
COPY --from=build /app/backend/node_modules ./backend/node_modules
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/frontend/dist ./frontend/dist
EXPOSE 4000
CMD ["node", "backend/dist/index.js"]
