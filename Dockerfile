# Imagem de produção: Node + TeX Live mínimo (latex, dvisvgm e os pacotes que o Mathsidian usa).
# Build em dois estágios: o front-end é compilado e pré-comprimido no primeiro, e só o resultado vai
# pra imagem final.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY shared shared
COPY scripts scripts
COPY web web
RUN npm run build -w web

FROM node:22-bookworm-slim
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
# TeX Live: latex + dvisvgm + amsmath/mathtools/tikz-cd/pgfplots/mhchem/preview/varwidth
RUN apt-get update && apt-get install -y --no-install-recommends \
      texlive-latex-base texlive-latex-recommended texlive-latex-extra texlive-pictures \
      texlive-science texlive-fonts-recommended dvisvgm ghostscript \
    && rm -rf /var/lib/apt/lists/* /usr/share/doc/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
RUN npm ci --omit=dev --no-audit --no-fund -w server && npm cache clean --force
COPY shared shared
COPY server/src server/src
COPY --from=build /app/web/dist web/dist
# o TeX roda código do usuário: processo sem root
RUN useradd --create-home --uid 10001 mathsidian && mkdir -p /data && chown mathsidian /data
USER mathsidian
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/src/index.js"]
