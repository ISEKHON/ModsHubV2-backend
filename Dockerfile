# Build stage
FROM node:20-slim AS build

WORKDIR /app

# Install OpenSSL
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Copy prisma schema BEFORE npm ci (needed for postinstall)
COPY prisma ./prisma

# Install dependencies (this will run postinstall and generate Prisma client)
RUN npm ci

# Copy rest of the application
COPY . .

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