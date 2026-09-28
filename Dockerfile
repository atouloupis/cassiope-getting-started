FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY public ./public
# Pas de VOLUME déclaré : un volume anonyme fausserait le test « avec / sans volume monté ».
# Exécuté en root : un volume fraîchement monté appartient à root et serait sinon illisible.
RUN mkdir -p /data /app/scratch
EXPOSE 3000
CMD ["node", "server.js"]
