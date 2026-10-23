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
  streams its text to the browser. The designer replies with a short note for
  the chat, then the file.
- **Art directions.** `src/directions.json` is a library of 33 distinct looks,
  each written as ingredients (composition, type, colour, imagery, details).
  Every request carries the whole library in a fresh random order, and for a
  new design the server names three random starting points, avoiding the
  directions of the person's recent designs. The designer builds from them,
  crossing ingredients as it likes, and records what it used in a
  `design-directions` meta tag. Left to choose freely, a model returns to its
  favourites; the server's dice are what keep designs varied.
- **Model and effort** are chosen in the UI (default Opus 5.5, medium) from the
  list in `src/main.rs`, served by `/api/options`.
- **Reference sites.** A link in a message ("make it look like
  getartcraft.com") is opened by `capture/capture.mjs` in headless Chromium:
  three desktop screens and a phone screenshot, plus the fonts, colours, radii
  and section structure the page really uses. These go to the designer with the
  request. Private and internal addresses are refused. Run it on its own with
  `CAPTURE_DEBUG=1 node capture/capture.mjs <url> <dir>` to see step timings.

## Running it

```bash
(cd capture && npm ci)
DEMO_PASSWORD=choose-one CHROMIUM_PATH=/path/to/chrome cargo run
# open http://localhost:8080
```

It uses whatever Claude Code login the machine has. In the container that is
`CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`).

| Variable | Meaning | Default |
|---|---|---|
| `DEMO_PASSWORD` | Password for the site (required) | — |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude login in the container | — |
| `CLAUDE_MODEL` | Default model in the picker | `claude-opus-5-5` |
| `CLAUDE_EFFORT` | Default effort in the picker | `medium` |
| `PORT` | Port | `8080` |
| `CHROMIUM_PATH` | Browser for reference sites | Playwright's own |
| `CAPTURE_SCRIPT` | Path of the capture script | `capture/capture.mjs` |
| `DESIGN_TIMEOUT_SECS` | Longest a design may take | `900` |

## Deploying

GitHub Actions builds the image and pushes `ghcr.io/wisdomose/design-harness`
on every push to `main`. Coolify runs that image; `deploy/coolify-watch.sh`,
run from cron on the server, asks Coolify to redeploy when `:latest` changes.
