#!/usr/bin/env node
// N-107 (QA-I1): tell a hibernating PDI from a broken one before the live
// smoke starts. Reads glide.buildtag with GET, retries with back-off for about
// five minutes, and writes the instance build to $GITHUB_STEP_SUMMARY. Nothing
// from the credentials is printed. Needs `npm run build` first.
//
//   SN_INSTANCE=… SN_USER=… SN_PASSWORD=… node scripts/live-wake.mjs
//
// Guarded by test/live-wake.test.js.
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { instanceBaseUrl } from "../build/core/host.js";

const PROBE_PATH =
  "/api/now/table/sys_properties?sysparm_query=name=glide.buildtag&sysparm_fields=value&sysparm_limit=1";
const ATTEMPT_TIMEOUT_MS = 30_000;

/**
 * What one probe answer means. A sleeping PDI answers with a redirect, an HTML
 * page or a 5xx rather than an API error, so anything that is not the Table
 * API's JSON counts as asleep. 401 and 403 mean it is awake and refused us.
 */
export function classifyProbe({ status, body }) {
  if (status === 401 || status === 403) {
    return { state: "refused", detail: `HTTP ${status}` };
  }
  if (status === 200) {
    try {
      const { result } = JSON.parse(body);
      if (Array.isArray(result)) {
        const build = result[0]?.value;
        return { state: "awake", build: build || "not visible to this user" };
      }
    } catch {
      // Not JSON: the hibernation page.
    }
  }
  return { state: "asleep", detail: `HTTP ${status}` };
}

/** Probe until the instance answers or `budgetMs` runs out. */
export async function waitForInstance({
  probe,
  sleep = delay,
  budgetMs = 300_000,
  firstDelayMs = 5_000,
  maxDelayMs = 60_000,
}) {
  let wait = firstDelayMs;
  let spent = 0;
  for (let attempts = 1; ; attempts++) {
    let outcome;
    try {
      outcome = classifyProbe(await probe());
    } catch (error) {
      outcome = { state: "asleep", detail: error.message };
    }
    if (outcome.state !== "asleep" || spent + wait > budgetMs) {
      return { ...outcome, attempts };
    }
    await sleep(wait);
    spent += wait;
    wait = Math.min(wait * 2, maxDelayMs);
  }
}

/** The step-summary line, and the error when the smoke should not go on. */
export function describeOutcome(outcome) {
  switch (outcome.state) {
    case "awake":
      return { summary: `Instance build: \`${outcome.build}\`` };
    case "refused":
      return {
        summary: `Instance refused the smoke account (${outcome.detail}).`,
        error: `Instance refused the smoke account (${outcome.detail}); check SN_USER and SN_PASSWORD.`,
      };
    default:
      return {
        summary: `Instance asleep after ${outcome.attempts} attempts (${outcome.detail}). Not a shape regression.`,
        error: `Instance asleep after ${outcome.attempts} attempts (${outcome.detail}); wake it from the developer portal.`,
      };
  }
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === import.meta.filename;

if (isMain) {
  const { SN_INSTANCE, SN_USER, SN_PASSWORD, GITHUB_STEP_SUMMARY } =
    process.env;
  const url = instanceBaseUrl(SN_INSTANCE ?? "") + PROBE_PATH;
  const token = Buffer.from(`${SN_USER}:${SN_PASSWORD}`).toString("base64");
  const outcome = await waitForInstance({
    probe: async () => {
      const res = await fetch(url, {
        headers: {
          Authorization: `Basic ${token}`,
          Accept: "application/json",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      return { status: res.status, body: await res.text() };
    },
  });
  const { summary, error } = describeOutcome(outcome);
  if (GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(GITHUB_STEP_SUMMARY, `${summary}\n\n`);
  }
  console.log(summary);
  if (error) {
    console.error(`::error::${error}`);
    process.exit(1);
  }
}
