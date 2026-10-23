// Captures a reference website for the designer: screenshots at desktop and
// phone width, plus the style facts a screenshot can't state exactly — the
// fonts, colours, corner radii and section structure the page really uses.
//
//   node capture.mjs <url> <output dir>
//
// Prints one JSON object on stdout. Screenshots are written as JPEGs into the
// output directory and listed by path. Requests to private addresses are
// refused, so a link can't be used to reach this server's own network.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";

const [url, outDir] = process.argv.slice(2);
if (!url || !outDir) {
  console.error("usage: capture.mjs <url> <output dir>");
  process.exit(2);
}

const started = Date.now();
// CAPTURE_DEBUG=1 prints how long each step took, on stderr.
const debug = process.env.CAPTURE_DEBUG
  ? (step) => console.error(`${((Date.now() - started) / 1000).toFixed(1)}s ${step}`)
  : () => {};

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const DESKTOP_SHOTS = 3; // first three screens of the page
const PHONE_HEIGHT = 2400;

// ---------------------------------------------------------------- private addresses

function isPrivate(ip) {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivate(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10 || a === 127 || a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT, which Tailscale uses
  );
}

const hostVerdicts = new Map();
async function allowedHost(host) {
  if (!hostVerdicts.has(host)) {
    hostVerdicts.set(
      host,
      (async () => {
        if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return false;
        if (isIP(host)) return !isPrivate(host);
        try {
          const addrs = await lookup(host, { all: true });
          return addrs.length > 0 && addrs.every((a) => !isPrivate(a.address));
        } catch {
          return false;
        }
      })(),
    );
  }
  return hostVerdicts.get(host);
}

// ---------------------------------------------------------------- reading the page

// Runs in the page. Counts what is actually painted, so the facts reflect the
// visible design rather than everything in the stylesheets.
function readStyle() {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  };
  const tally = (map, key, weight = 1) => key && map.set(key, (map.get(key) || 0) + weight);
  const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);

  const bg = new Map();
  const text = new Map();
  const radii = new Map();
  const families = new Map();
  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el)) continue;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (s.backgroundColor && s.backgroundColor !== "rgba(0, 0, 0, 0)") tally(bg, s.backgroundColor, r.width * r.height);
    if (el.childNodes.length && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) {
      tally(text, s.color, el.textContent.length);
      tally(families, s.fontFamily, el.textContent.length);
    }
    if (s.borderRadius && s.borderRadius !== "0px") tally(radii, s.borderRadius);
  }

  const sample = (selector) => {
    const el = [...document.querySelectorAll(selector)].find(visible);
    if (!el) return null;
    const s = getComputedStyle(el);
    return {
      text: el.textContent.trim().replace(/\s+/g, " ").slice(0, 80),
      fontFamily: s.fontFamily,
      fontSize: s.fontSize,
      fontWeight: s.fontWeight,
      lineHeight: s.lineHeight,
      letterSpacing: s.letterSpacing,
      textTransform: s.textTransform,
      fontStyle: s.fontStyle,
      color: s.color,
    };
  };

  // The page's top-level blocks, top to bottom, with their headings: the
  // section rhythm a screenshot shows only for the first few screens.
  const root = document.querySelector("main") || document.body;
  let blocks = [...root.children].filter(visible);
  if (blocks.length === 1 && blocks[0].children.length > 2) blocks = [...blocks[0].children].filter(visible);
  const sections = blocks.slice(0, 25).map((el) => {
    const r = el.getBoundingClientRect();
    const heading = el.querySelector("h1, h2, h3");
    return {
      tag: el.tagName.toLowerCase(),
      height: Math.round(r.height),
      background: getComputedStyle(el).backgroundColor,
      heading: heading ? heading.textContent.trim().replace(/\s+/g, " ").slice(0, 80) : null,
      images: el.querySelectorAll("img, picture, video, svg").length,
    };
  });

  return {
    title: document.title,
    pageHeight: document.documentElement.scrollHeight,
    fontFamilies: top(families, 4),
    backgroundColors: top(bg, 8),
    textColors: top(text, 6),
    borderRadii: top(radii, 6),
    typography: {
      h1: sample("h1"),
      h2: sample("h2"),
      h3: sample("h3"),
      body: sample("p"),
      button: sample("button, a[class*='button' i], a[class*='btn' i]"),
      nav: sample("nav a, header a"),
    },
    sections,
  };
}

// ---------------------------------------------------------------- capture

async function settle(page, scrollTo) {
  await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});
  // Close the commonest cookie and consent banners so they don't cover the
  // design. One look through the page; asking per label took seconds.
  await page.evaluate(() => {
    const labels = ["accept all", "accept", "i agree", "agree", "got it", "ok", "allow all"];
    const buttons = [...document.querySelectorAll("button, [role=button]")];
    for (const label of labels) {
      const hit = buttons.find((b) => b.textContent.trim().toLowerCase() === label && b.offsetParent);
      if (hit) return hit.click();
    }
  });
  // Scroll through the part that will be photographed, so lazy images and
  // scroll animations there have loaded, then back to the top.
  await page.evaluate(async (bottom) => {
    for (let y = 0; y < Math.min(document.documentElement.scrollHeight, bottom); y += 900) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 100));
    }
    window.scrollTo(0, 0);
  }, scrollTo);
  await page.waitForTimeout(500);
}

async function guard(context) {
  await context.route("**/*", async (route) => {
    const { protocol, hostname } = new URL(route.request().url());
    if ((protocol === "http:" || protocol === "https:") && (await allowedHost(hostname))) return route.continue();
    if (protocol === "data:" || protocol === "blob:") return route.continue();
    return route.abort("blockedbyclient");
  });
}

const target = new URL(url);
if (!(await allowedHost(target.hostname))) {
  console.log(JSON.stringify({ ok: false, url, error: "That address is private or does not exist." }));
  process.exit(0);
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
async function shootDesktop() {
  const shots = [];
  const context = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 1 });
  await guard(context);
  const page = await context.newPage();
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
  if (response && response.status() >= 400) throw new Error(`the site answered ${response.status()}`);
  debug("desktop loaded");
  await settle(page, DESKTOP_SHOTS * DESKTOP.height);
  debug("desktop settled");
  const style = await page.evaluate(readStyle);
  debug("styles read");
  for (let i = 0; i < DESKTOP_SHOTS; i++) {
    const y = i * DESKTOP.height;
    if (i > 0 && y >= style.pageHeight) break;
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(400);
    const path = join(outDir, `desktop-${i + 1}.jpg`);
    await writeFile(path, await page.screenshot({ type: "jpeg", quality: 70 }));
    shots.push({ path, label: `Desktop, screen ${i + 1} (from ${y}px down)` });
    debug(`desktop screenshot ${i + 1}`);
  }
  const finalUrl = page.url();
  await context.close();
  return { style, shots, finalUrl };
}

async function shootPhone() {
  const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await guard(context);
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
  await settle(page, PHONE_HEIGHT);
  const height = Math.min(await page.evaluate(() => document.documentElement.scrollHeight), PHONE_HEIGHT);
  const path = join(outDir, "phone.jpg");
  await writeFile(
    path,
    await page.screenshot({ type: "jpeg", quality: 70, fullPage: true, clip: { x: 0, y: 0, width: PHONE.width, height } }),
  );
  await context.close();
  debug("phone screenshot");
  return { path, label: "Phone, top of the page" };
}

try {
  // One width at a time: two pages of a heavy site at once crash Chromium in
  // 1GB, and the server is short of memory. Parallel saved only ~5s.
  const desktop = await shootDesktop();
  const phone = await shootPhone().catch(() => null);
  const screenshots = phone ? [...desktop.shots, phone] : desktop.shots;
  console.log(JSON.stringify({ ok: true, url: desktop.finalUrl, style: desktop.style, screenshots }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, url, error: String(err.message || err).split("\n")[0] }));
} finally {
  await browser.close();
}
