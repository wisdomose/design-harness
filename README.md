# Design Harness

A demo of an agent that designs. Describe what you need ("I have a streetwear
brand in Lagos and I want a website"), and it creates a design system, then a
page built from it, on a canvas you can pan and zoom. Ask for changes in the
chat; export the design as an HTML file, a PNG or the design system as CSS.

## How it works

- **The design file is one HTML document.** Its `@theme` block (Tailwind v4)
  is the design system: colours, fonts and radii. The body is the page, written
  only in those tokens, so changing a token changes the whole page.
- **The canvas** shows the file three ways: the design system as a board, the
  page at 1440px and at 390px.
- **The server** (Rust, axum) runs the Claude Code command-line tool for each
  request, with no tools and the designer instructions in `src/prompt.md`, and
  streams its text to the browser.

## Running it

```bash
DEMO_PASSWORD=choose-one cargo run
# open http://localhost:8080
```

It uses whatever Claude Code login the machine has. In the container that is
`CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`).

| Variable | Meaning | Default |
|---|---|---|
| `DEMO_PASSWORD` | Password for the site (required) | — |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude login in the container | — |
| `CLAUDE_MODEL` | Model for designing | `claude-sonnet-5-5` |
| `PORT` | Port | `8080` |
| `DESIGN_TIMEOUT_SECS` | Longest a design may take | `600` |

## Deploying

GitHub Actions builds the image and pushes `ghcr.io/wisdomose/design-harness`
on every push to `main`. Coolify runs that image; `deploy/coolify-watch.sh`,
run from cron on the server, asks Coolify to redeploy when `:latest` changes.
