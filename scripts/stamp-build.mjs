#!/usr/bin/env node
/**
 * stamp-build.mjs — give the deployed front-end a version it can check.
 *
 * WHY THIS EXISTS
 * ---------------
 * This site is a hash-routed single-page app. A reader who opens it and
 * leaves the tab there never triggers a navigation, so the service worker's
 * network-first shell rule never runs again and the tab keeps executing the
 * JavaScript it downloaded when it opened — for hours, across any number of
 * deploys. Every fix shipped in that window is invisible to that reader, and
 * the site gives them no way to know.
 *
 * The edition watcher already handles new DATA, which needs no reload because
 * the renderer re-reads the feeds. New CODE is the opposite: only a reload
 * can pick it up. This writes the hash the running page compares itself
 * against.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const FILES = ["public/index.html", "public/signal.js", "public/signal.css", "public/sw.js"];
const h = createHash("sha256");
for (const f of FILES) h.update(readFileSync(f));
const build = h.digest("hex").slice(0, 12);

writeFileSync("public/build.json",
  JSON.stringify({ build, at: new Date().toISOString(), files: FILES.length }) + "\n");
console.log("build", build);
