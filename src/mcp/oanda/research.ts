// Pre-trade research: what is happening to these two currencies right now.
//
// The rest of this server is quantitative — price, ATR, spread, carry, backtests.
// None of it knows that CPI prints in forty minutes, or that a central bank spoke
// this morning, and those are exactly the things that turn a good technical setup
// into a gap through the stop. This module is the qualitative half: it searches
// the web for each side of the pair, reads the most promising pages, and hands
// back sourced excerpts for the model to weigh.
//
// Deliberately NOT a verdict. It does not score sentiment or return
// "trade/don't trade": a scraped headline is weak evidence, and a number computed
// from weak evidence reads far more authoritative than it deserves to. The model
// gets the excerpts and the timestamps, and has to make the call in the open.
//
// Search and fetch are reused from the assistant's own web tools rather than
// reimplemented, so this inherits one backend selection (Tavily → Brave →
// DuckDuckGo), one timeout budget, and — the important one — the SSRF guard that
// keeps a URL from pointing at localhost.

import { webSearch, fetchPage, type SearchResult } from "../../core/webTools.js";

/** ISO 4217 → the things you would actually search for about that currency. */
const CENTRAL_BANKS: Record<string, string> = {
  USD: "Federal Reserve FOMC",
  EUR: "European Central Bank ECB",
  GBP: "Bank of England BoE",
  JPY: "Bank of Japan BoJ",
  CHF: "Swiss National Bank SNB",
  AUD: "Reserve Bank of Australia RBA",
  NZD: "Reserve Bank of New Zealand RBNZ",
  CAD: "Bank of Canada BoC",
  SEK: "Riksbank",
  NOK: "Norges Bank",
  MXN: "Banco de Mexico",
  ZAR: "South African Reserve Bank",
  CNH: "People's Bank of China PBoC",
  SGD: "Monetary Authority of Singapore MAS",
  HKD: "Hong Kong Monetary Authority",
  TRY: "Central Bank of Turkey CBRT",
  PLN: "Narodowy Bank Polski",
  CZK: "Czech National Bank",
  HUF: "Magyar Nemzeti Bank",
  XAU: "gold market",
  XAG: "silver market",
};

export interface ResearchTopic {
  /** What this lookup was trying to establish. */
  angle: string;
  query: string;
  results: SearchResult[];
  error?: string;
}

export interface ResearchExcerpt {
  url: string;
  title: string;
  /** Trimmed page text — evidence to quote, not a summary. */
  excerpt: string;
  error?: string;
}

export interface PreTradeResearch {
  instrument: string;
  currencies: string[];
  generatedAt: string;
  backendNote: string;
  topics: ResearchTopic[];
  excerpts: ResearchExcerpt[];
  /** Questions the model must answer from the material before it trades. */
  checklist: string[];
  caveats: string[];
}

/**
 * The searches worth running for one instrument.
 *
 * One angle per query rather than a single fat query: search backends do badly
 * with "EURUSD ECB CPI NFP outlook forecast", and separate queries make it
 * obvious in the output which angle came back empty.
 */
function buildQueries(instrument: string, currencies: string[], extra?: string): ResearchTopic[] {
  const pair = instrument.replace("_", "/");
  const topics: Array<{ angle: string; query: string }> = [
    {
      angle: "Near-term direction and levels being talked about for this pair",
      query: `${pair} forecast analysis this week`,
    },
    {
      angle: "Scheduled economic releases that could move it while the trade is open",
      query: `forex economic calendar ${currencies.join(" ")} this week high impact releases`,
    },
  ];

  for (const currency of currencies) {
    const bank = CENTRAL_BANKS[currency];
    topics.push({
      angle: `Policy and rate expectations for ${currency}`,
      query: bank
        ? `${bank} latest decision rate expectations ${currency}`
        : `${currency} central bank interest rate outlook`,
    });
  }

  if (extra && extra.trim().length > 0) {
    topics.push({ angle: "Your specific question", query: extra.trim() });
  }

  return topics.map((topic) => ({ ...topic, results: [] }));
}

/**
 * Which of the search hits are worth spending a page fetch on.
 *
 * Two hosts at most from any one domain, so a site that dominates the results for
 * "EUR/USD forecast" — and they do — cannot crowd out every other view.
 */
function pickPagesToRead(topics: ResearchTopic[], limit: number): SearchResult[] {
  const perDomain = new Map<string, number>();
  const picked: SearchResult[] = [];
  const seen = new Set<string>();

  // Round-robin across topics so every angle contributes before any angle
  // contributes twice.
  for (let rank = 0; rank < 4 && picked.length < limit; rank++) {
    for (const topic of topics) {
      if (picked.length >= limit) break;
      const hit = topic.results[rank];
      if (!hit?.url || seen.has(hit.url)) continue;

      let domain: string;
      try {
        domain = new URL(hit.url).hostname.replace(/^www\./, "");
      } catch {
        continue;
      }
      const used = perDomain.get(domain) ?? 0;
      if (used >= 2) continue;

      perDomain.set(domain, used + 1);
      seen.add(hit.url);
      picked.push(hit);
    }
  }

  return picked;
}

/**
 * Run the pre-trade research for one instrument.
 *
 * Never throws: this is called from a tool the model may run before a live order,
 * and a failed scrape must degrade to "I could not find this out" rather than
 * abort the check. Every failure is reported in the payload instead.
 */
export async function researchInstrument(options: {
  instrument: string;
  currencies: string[];
  question?: string;
  /** Pages to actually read. 0 returns search results only, which is much faster. */
  readPages?: number;
  resultsPerQuery?: number;
  excerptChars?: number;
}): Promise<PreTradeResearch> {
  const { instrument, currencies, question } = options;
  const readPages = Math.min(Math.max(options.readPages ?? 3, 0), 6);
  const perQuery = Math.min(Math.max(options.resultsPerQuery ?? 5, 1), 10);
  const excerptChars = Math.min(Math.max(options.excerptChars ?? 2_000, 400), 6_000);

  const topics = buildQueries(instrument, currencies, question);

  // Searches run together: four sequential scrapes is most of a minute, and the
  // model is holding a turn open waiting for this.
  await Promise.all(
    topics.map(async (topic) => {
      try {
        const outcome = await webSearch(topic.query, perQuery);
        topic.results = outcome.results ?? [];
        if (outcome.error) topic.error = outcome.error;
      } catch (err: any) {
        topic.error = `Search failed: ${err?.message ?? String(err)}`;
      }
    })
  );

  const excerpts: ResearchExcerpt[] = [];
  if (readPages > 0) {
    const pages = pickPagesToRead(topics, readPages);
    const fetched = await Promise.all(
      pages.map(async (page): Promise<ResearchExcerpt> => {
        try {
          const result = await fetchPage(page.url, excerptChars);
          if (result.error) {
            return { url: page.url, title: page.title, excerpt: "", error: result.error };
          }
          return {
            url: page.url,
            title: result.title || page.title,
            excerpt: result.text.trim(),
          };
        } catch (err: any) {
          return {
            url: page.url,
            title: page.title,
            excerpt: "",
            error: `Could not read the page: ${err?.message ?? String(err)}`,
          };
        }
      })
    );
    excerpts.push(...fetched);
  }

  const found = topics.reduce((sum, topic) => sum + topic.results.length, 0);

  return {
    instrument,
    currencies,
    generatedAt: new Date().toISOString(),
    backendNote:
      `${found} search result(s) across ${topics.length} angle(s); ${excerpts.length} page(s) read. ` +
      `Set TAVILY_API_KEY or BRAVE_SEARCH_API_KEY for better results than the keyless fallback.`,
    topics,
    excerpts,
    checklist: [
      "Is there a high-impact release for either currency before this trade's expected exit? If yes, either size down or wait for it.",
      "Is the trade with or against the direction implied by rate expectations on both currencies?",
      "Has a central bank spoken in the last 24 hours, or is one due to?",
      "Does anything here explain today's price action better than the technical setup does?",
      "Is any of this actually recent? Check the dates before relying on it.",
    ],
    caveats: [
      "Scraped web pages, not a licensed data feed: coverage is patchy and dates are easy to misread.",
      "No sentiment score is produced on purpose — quote the source and reason in the open rather than trusting a number derived from headlines.",
      "Absence of results is not absence of risk. If a calendar lookup came back empty, treat the event risk as unknown, not zero.",
    ],
  };
}
