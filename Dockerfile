# Use official lightweight Node.js 20 image
FROM node:20-alpine

# Set working directory inside the container
WORKDIR /app

# Copy dependency files first for faster builds
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production

# Copy all your code and data files
COPY . .

# Set file permissions
RUN chown -R node:node /app
USER node

# Start the bot
CMD ["npm", "start"]
