# Use a lean Node.js base image
FROM node:20-alpine

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json to leverage Docker cache
# This step is done separately to ensure dependencies are re-installed only when package.json changes
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of the application code
# The 'public' directory contains index.html for configuration
COPY . .

# Expose the port the addon listens on (default Stremio addon port)
EXPOSE 7000

# Command to run the application
# Use 'npm start' as defined in package.json
CMD ["npm", "start"]
