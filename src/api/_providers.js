/**
 * _providers.js — the seam between this product and whoever supplies its prices.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every price on this site comes from Yahoo Finance's `spark` and `chart`
 * endpoints. Those are undocumented: they carry no terms of service anyone
 * agreed to, no uptime commitment, and no redistribution right. That is
 * survivable for a research site read by its author and stated plainly on the
 * Data Sources page — and it is NOT survivable the day this needs a licensed
 * exchange feed, which for Indian real-time data means NSE's own subscription
 * products.
 *
 * Before this file, swapping providers meant editing every route. Now it means
 * writing one object with two methods and changing MARKET_PROVIDER.
 *
 * WHAT A PROVIDER MUST IMPLEMENT
 *   id        stable short name, shown on the Data Sources page
 *   label     human name
 *   terms     honest one-liner about what this feed is and is not
 *   realtime  false unless the feed is contractually real-time
 *   quotes(defs)            → Map<yahooSymbol, {price, prev, …meta}>
 *   series(symbols, range)  → Map<symbol, [[epochSec, close], …]>
 *
 * A provider that cannot answer must return an empty Map. It must NEVER
 * invent, interpolate or carry forward a value — every caller downstream is
 * written to render "—" for a missing quote, and a fabricated number would
 * sail through all of them.
 */
import { quoteAll, sparkSeries } from "./ticker.js";

/** The endpoints this site actually calls today. Undocumented, unlicensed. */
const yahoo = {
  id: "yahoo",
  label: "Yahoo Finance",
  terms: "Undocumented public endpoints. Delayed, best-effort, no redistribution right, " +
         "no uptime commitment. Adequate for research; not a licensed market-data feed.",
  realtime: false,
  attribution: "Quotes and daily closes via Yahoo Finance.",
  quotes: (defs, priority) => quoteAll(defs, priority),
  series: (symbols, range, interval) => sparkSeries(symbols, range, interval),
};

/**
 * Placeholder for a licensed feed. Deliberately NOT a stub that returns fake
 * data — it throws, so wiring it up half-way fails loudly instead of quietly
 * serving nothing and looking like an outage.
 */
const licensed = {
  id: "licensed",
  label: "Licensed exchange feed",
  terms: "Not configured. Requires an NSE/MCX data agreement before use.",
  realtime: true,
  attribution: "",
  quotes: () => { throw new Error("licensed provider is not configured"); },
  series: () => { throw new Error("licensed provider is not configured"); },
};

const REGISTRY = { yahoo, licensed };

/** Chosen by env so a swap is a deploy variable, not a code change. */
export function provider() {
  const want = (globalThis.process?.env?.MARKET_PROVIDER || "yahoo").toLowerCase();
  return REGISTRY[want] || yahoo;
}

/** What the Data Sources page prints. No secrets, safe to serve publicly. */
export function providerInfo() {
  const p = provider();
  return { id: p.id, label: p.label, terms: p.terms, realtime: p.realtime,
           attribution: p.attribution, available: Object.keys(REGISTRY) };
}
