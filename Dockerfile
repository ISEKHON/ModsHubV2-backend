# Build stage
FROM node:20-slim AS build

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

# Generate Prisma client
RUN npx prisma generate

# Build app
RUN npm run build

# Runtime stage
FROM node:20-slim

WORKDIR /app

ENV NODE_ENV=production

# Install OpenSSL for Prisma
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/uploads ./uploads

EXPOSE 4000

CMD ["node", "dist/index.js"]