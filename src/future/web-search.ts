export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchProvider {
  search(query: string, options?: { limit?: number }): Promise<WebSearchResult[]>;
}

// Future seam only. V1 intentionally does not bind to Brave, Tavily, or any other provider.
