import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wakeFetchIfStale } from "../src/github";
import { getMeta, putMeta, emptyMeta } from "../src/state";
import { installNetworkStub } from "./helpers";

const MINUTE = 60_000;

afterEach(async () => {
  vi.unstubAllGlobals();
  await reset();
});

function wakeEnv(): Env {
  return {
    STATE: env.STATE,
    BOT_TOKEN: "test-token",
    QUEUE: "5.1",
    DIGEST_TIME: "",
    DIGEST_TZ: "Europe/Kyiv",
    DRY_RUN: "0",
    GITHUB_TOKEN: "test-gh-token",
  } as unknown as Env;
}

describe("сторож wakeFetchIfStale", () => {
  it("свіжий /ingest — GitHub не будиться", async () => {
    installNetworkStub({ page: "" });
    const e = wakeEnv();
    await putMeta(e, { ...emptyMeta(), lastIngestAt: Date.now() - MINUTE });

    expect(await wakeFetchIfStale(e)).toBe(false);
    const meta = await getMeta(e);
    expect(meta.lastDispatchAt ?? 0).toBe(0);
  });

  it("тиша > 3 хв — будить zoe-fetch і фіксує lastDispatchAt", async () => {
    const net = installNetworkStub({ page: "" });
    const e = wakeEnv();
    await putMeta(e, {
      ...emptyMeta(),
      lastIngestAt: Date.now() - 4 * MINUTE,
      lastDispatchAt: Date.now() - 5 * MINUTE,
    });

    expect(await wakeFetchIfStale(e)).toBe(true);
    expect(net.githubDispatches).toBe(1);
    const meta = await getMeta(e);
    expect(meta.lastDispatchAt ?? 0).toBeGreaterThan(0);
  });

  it("не турбує GitHub частіше ніж раз на 3 хв", async () => {
    const net = installNetworkStub({ page: "" });
    const e = wakeEnv();
    await putMeta(e, {
      ...emptyMeta(),
      lastIngestAt: Date.now() - 10 * MINUTE,
      lastDispatchAt: Date.now() - MINUTE,
    });

    expect(await wakeFetchIfStale(e)).toBe(false);
    expect(net.githubDispatches).toBe(0);
  });

  it("без GITHUB_TOKEN — не падає, просто не будить", async () => {
    installNetworkStub({ page: "" });
    const e = { ...wakeEnv(), GITHUB_TOKEN: "" } as unknown as Env;
    await putMeta(e, { ...emptyMeta(), lastIngestAt: Date.now() - 10 * MINUTE });

    await expect(wakeFetchIfStale(e)).resolves.toBe(false);
  });
});
