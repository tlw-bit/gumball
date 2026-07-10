# Use official lightweight Node.js 20 image
FROM node:20-alpine

# Set working directory inside the container
WORKDIR /app

# Copy dependency files first
COPY package*.json ./

# Install dependencies
RUN npm install --only=production

# Copy the rest of your bot code
COPY . .

# Start the bot
CMD ["npm", "start"]
