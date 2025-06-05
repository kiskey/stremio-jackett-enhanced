# Use a lean Node.js base image
FROM node:20-alpine

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json to leverage Docker cache
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the application code including the worker file
COPY . .

# Expose the port the addon listens on (default Stremio addon port)
EXPOSE 7000

# Command to run the application
CMD ["node", "server.js"]
