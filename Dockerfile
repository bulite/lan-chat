FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8910 CHAT_DATA=/data
WORKDIR /app
COPY package.json server.mjs communication.mjs roles.mjs audits.mjs role-context.mjs ./
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8910
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
