// src/self_improvement/InternetCrawlerService.ts

/**
 * Service responsible for crawling public web resources needed for self‑improvement.
 * It provides simple wrappers around common APIs (generic web fetch, StackOverflow,
 * arXiv) and returns markdown‑friendly content.
 */

import axios from "axios";

/** Convert raw HTML to a markdown‑ish string using a very simple heuristic. */
function htmlToMarkdown(html: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "";
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  const bodyText = body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `# ${title}\n\n${bodyText}`;
}

export class InternetCrawlerService {
  /** Fetch a generic web page and return a markdown representation. */
  public static async fetchWebPage(url: string): Promise<string> {
    const response = await axios.get(url, { timeout: 10000 });
    if (response.status !== 200) {
      throw new Error(`Unable to fetch URL ${url}: ${response.status}`);
    }
    return htmlToMarkdown(response.data);
  }

  /** Search StackOverflow via the public API and return top N question titles + links. */
  public static async searchStackOverflow(query: string, topN = 5): Promise<string[]> {
    const encoded = encodeURIComponent(query);
    const apiUrl = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encoded}&site=stackoverflow&filter=default`;
    const resp = await axios.get(apiUrl);
    const items = resp.data?.items ?? [];
    return items.slice(0, topN).map((item: any) => `${item.title} (https://stackoverflow.com/a/${item.answer_id || item.question_id})`);
  }

  /** Search arXiv for recent papers matching the query and return titles + pdf links. */
  public static async searchArxiv(query: string, topN = 5): Promise<string[]> {
    const encoded = encodeURIComponent(query);
    const apiUrl = `http://export.arxiv.org/api/query?search_query=all:${encoded}&start=0&max_results=${topN}`;
    const resp = await axios.get(apiUrl, { responseType: "text" });
    // Very lightweight parsing – extract <entry> titles and ids.
    const matches = resp.data.match(/<entry>([\s\S]*?)<\/entry>/g) ?? [];
    return matches.map((entry) => {
      const titleMatch = entry.match(/<title>\s*([^<]+)\s*<\/title>/);
      const idMatch = entry.match(/<id>\s*([^<]+)\s*<\/id>/);
      const title = titleMatch ? titleMatch[1].trim() : "Untitled";
      const id = idMatch ? idMatch[1].trim() : "";
      return `${title} (${id.replace("http://arxiv.org/abs/", "https://arxiv.org/pdf/")}.pdf)`;
    });
  }
}
