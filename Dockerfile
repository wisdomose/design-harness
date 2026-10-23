# Design Harness demo. Built on GitHub Actions; the server only pulls it.
FROM rust:1.97-slim AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
# Cache dependencies separately from the source.
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release && rm -rf src
COPY src ./src
COPY web ./web
RUN touch src/main.rs && cargo build --release

FROM debian:trixie-slim
# The design agent is the Claude Code command-line tool, signed in with
# CLAUDE_CODE_OAUTH_TOKEN at run time.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl nodejs npm \
    && npm install -g @anthropic-ai/claude-code \
    && npm cache clean --force \
    && apt-get purge -y npm && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --uid 10001 app
COPY --from=build /app/target/release/design-harness /usr/local/bin/design-harness
USER app
ENV HOME=/home/app PORT=8080 WORK_DIR=/home/app/work SECURE_COOKIE=true \
    DISABLE_AUTOUPDATER=1 RUST_LOG=design_harness=info
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD curl -fs http://localhost:8080/health || exit 1
CMD ["design-harness"]
