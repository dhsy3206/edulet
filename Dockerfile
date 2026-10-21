# Edulet — zero runtime dependencies, so the image is just Node + the sources.
FROM node:22-alpine
ENV NODE_ENV=production \
    EDULET_PORT=3000 \
    EDULET_DATA_DIR=/data
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
COPY seed ./seed
# developer-only pages (public/_dev) must not ship in the image
RUN rm -rf /app/public/_dev && mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.EDULET_PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
