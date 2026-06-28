FROM node:20-slim

# Install ffmpeg
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy app source code
COPY . .

# Create temporary upload directory inside container
RUN mkdir -p temp-uploads

# Expose port
EXPOSE 5000

# Set start script
CMD [ "npm", "start" ]
