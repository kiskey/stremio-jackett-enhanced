# Use an official Node.js runtime as a parent image
FROM node:20-alpine

# Set the working directory in the container
WORKDIR /app

# Install app dependencies
# A wildcard is used to ensure both package.json and package-lock.json are copied
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy app source code to the working directory
COPY . .

# Expose the port the app runs on
EXPOSE 7000

# Define environment variables for configuration (can be overridden at runtime)
ENV JACKETT_URL="http://localhost:9117"
ENV JACKETT_API_KEY="YOUR_JACKETT_API_KEY"
ENV OMDB_API_KEY="YOUR_OMDB_API_KEY"
ENV TMDB_API_KEY="YOUR_TMDB_API_KEY"
ENV PREFERRED_RESOLUTIONS="2160p,1080p,720p"
ENV PREFERRED_LANGUAGES="Tamil,Hindi,Malayalam,Telugu,English,Japanese,Korean,Chinese"
ENV MAX_RESULTS="50"
ENV MAX_SIZE="0" # New: Max size in bytes (0 means no restriction). Example: 5368709120 for 5GB
ENV LOG_LEVEL="info" # Default logging level: debug, info, warn, error, silent
ENV PUBLIC_TRACKERS_URL="https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all.txt"

# Run the application
CMD ["node", "server.js"]
