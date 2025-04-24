FROM node:18-alpine

# Install pnpm
RUN npm install -g pnpm

# Set working directory
WORKDIR /app

# Copy package files for efficient caching
COPY package.json ./app
COPY . /app/

# Install dependencies using pnpm
RUN pnpm install --prod --frozen-lockfile

ENV NODE_ENV=production
ENV PORT=4040

# Expose the port the app runs on
EXPOSE 4040

# Start the scaffold server
CMD ["node", "dist/index.js"]