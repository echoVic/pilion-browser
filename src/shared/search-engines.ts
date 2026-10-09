export const SEARCH_ENGINE_IDS = ['google', 'bing', 'duckduckgo'] as const;
export type SearchEngine = (typeof SEARCH_ENGINE_IDS)[number];

export const SEARCH_ENGINES: Record<SearchEngine, { name: string; url: string }> = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
};
