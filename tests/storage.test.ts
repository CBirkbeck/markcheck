import { describe, it, expect, beforeEach } from "vitest";
import { getScrape, setScrape, getMapping, setMapping, clearAll } from "../src/lib/storage";
import type { ScrapeResult } from "../src/lib/types";

function installChromeMock() {
  const store: Record<string, unknown> = {};
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: async (keys: string[]) => Object.fromEntries(keys.map((k) => [k, store[k]])),
        set: async (obj: Record<string, unknown>) => Object.assign(store, obj),
        remove: async (keys: string[]) => keys.forEach((k) => delete store[k]),
      },
    },
  };
}

const sample: ScrapeResult = { students: [], marks: [], failures: [], scrapedAt: "2026-06-02T00:00:00Z" };

describe("storage", () => {
  beforeEach(installChromeMock);

  it("round-trips a scrape result", async () => {
    expect(await getScrape()).toBeNull();
    await setScrape(sample);
    expect(await getScrape()).toEqual(sample);
  });

  it("round-trips mapping and clears everything", async () => {
    await setMapping([{ columnId: "1", blackboardLabel: "x", module: "M", target: "001" }]);
    expect((await getMapping()).length).toBe(1);
    await setScrape(sample);
    await clearAll();
    expect(await getScrape()).toBeNull();
    expect(await getMapping()).toEqual([]);
  });
});
