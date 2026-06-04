import type { MappingEntry, ScrapeResult } from "./types";

const SCRAPE_KEY = "markcheck.scrape";
const MAPPING_KEY = "markcheck.mapping";

export async function getScrape(): Promise<ScrapeResult | null> {
  const r = await chrome.storage.local.get([SCRAPE_KEY]);
  return (r[SCRAPE_KEY] as ScrapeResult) ?? null;
}
export async function setScrape(s: ScrapeResult): Promise<void> {
  await chrome.storage.local.set({ [SCRAPE_KEY]: s });
}
export async function getMapping(): Promise<MappingEntry[]> {
  const r = await chrome.storage.local.get([MAPPING_KEY]);
  return (r[MAPPING_KEY] as MappingEntry[]) ?? [];
}
export async function setMapping(m: MappingEntry[]): Promise<void> {
  await chrome.storage.local.set({ [MAPPING_KEY]: m });
}
export async function clearAll(): Promise<void> {
  await chrome.storage.local.remove([SCRAPE_KEY, MAPPING_KEY]);
}
