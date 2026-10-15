// Deep research harness.
//
// The pipeline is orchestrated in CODE, not by asking the model to plan and
// sequence its own research. A 9B local model cannot reliably run a multi-stage
// investigation via tool calls — it loops, forgets steps, and stops early. So
// each stage here is a separate, narrowly-scoped model call with a fixed
// contract, and the fan-out, deduplication and citation bookkeeping happen in
// TypeScript where they are deterministic.
//
// Stages:
//   1. Decompose  — turn the topic into distinct sub-questions
//   2. Search     — one web search per sub-question, results pooled and deduped
//   3. Read       — fetch the highest-value unique sources
//   4. Extract    — pull claims from each source, each tied to its URL
//   5. Verify     — adversarially challenge each claim against the other sources
//   6. Synthesize — write a cited report from surviving claims only
//
// Every stage streams progress, because on local models this takes minutes and
// a silent UI is indistinguishable from a hang.

import { EventEmitter } from "events";
import ollama from "ollama";
import { webSearch, fetchPage, activeSearchBackend, type SearchResult } from "./webTools.js";
import { wrapUntrusted, sourceLabel } from "./untrusted.js";
import { getEffortProfile, getSettings, debugLog } from "./session.js";
import { AssistantError } from "./provider.js";

export interface ResearchSource {
  index: number;
  url: string;
  title: string;
  chars: number;
  truncated: boolean;
}

export interface ResearchClaim {
  text: string;
  sourceIndex: number;
  verdict: "supported" | "unsupported" | "contested";
  reason?: string;
}

export interface ResearchReport {
  topic: string;
  backend: string;
  subQuestions: string[];
  sources: ResearchSource[];
  claims: ResearchClaim[];
  report: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number; calls: number };
  warnings: string[];
}

/** Breadth scales with /effort, because each extra source costs a model call. */
interface Budget {
  subQuestions: number;
  resultsPerQuestion: number;
  sourcesToRead: number;
  claimsPerSource: number;
  verifyClaims: number;
}

function budgetFor(effort: "low" | "medium" | "high"): Budget {
  if (effort === "low") {
    return { subQuestions: 2, resultsPerQuestion: 4, sourcesToRead: 3, claimsPerSource: 3, verifyClaims: 4 };
  }
  if (effort === "high") {
    return { subQuestions: 5, resultsPerQuestion: 8, sourcesToRead: 8, claimsPerSource: 5, verifyClaims: 14 };
  }
  return { subQuestions: 3, resultsPerQuestion: 6, sourcesToRead: 5, claimsPerSource: 4, verifyClaims: 8 };
}

export class DeepResearchEngine extends EventEmitter {
  private model: string;
  private usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
  private warnings: string[] = [];

  constructor(model: string) {
    super();
    this.model = model;
  }

  private status(stage: string, message: string, extra: Record<string, unknown> = {}) {
    this.emit("progress", { stage, message, ...extra, timestamp: Date.now() });
  }

  /**
   * One model call with no tools. Returns raw text.
   *
   * Thinking is disabled explicitly. Reasoning models (the whole qwen3.x family)
   * otherwise spend the entire num_predict budget inside `message.thinking` and
   * return empty `content` — measured at 3900 characters of reasoning and zero
   * output. These stages are mechanical extraction, not reasoning problems, so
   * the depth belongs in the pipeline rather than in each call.
   */
  private async ask(system: string, user: string, maxTokens = 1200): Promise<string> {
    const response: any = await ollama.chat({
      model: this.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      think: false,
      options: { num_predict: maxTokens },
    } as any);

    this.usage.promptTokens += response?.prompt_eval_count ?? 0;
    this.usage.completionTokens += response?.eval_count ?? 0;
    this.usage.totalTokens = this.usage.promptTokens + this.usage.completionTokens;
    this.usage.calls += 1;

    this.emit("usage", { ...this.usage });

    const message = response?.message ?? {};
    const content = typeof message.content === "string" ? message.content.trim() : "";
    // Reasoning models sometimes spend everything on `thinking`.
    return content || (typeof message.thinking === "string" ? message.thinking.trim() : "");
  }

  /**
   * Ask for JSON and parse it defensively. Small models wrap JSON in prose or
   * fences constantly, so we extract rather than trust.
   */
  private async askJson<T>(
    system: string,
    user: string,
    fallback: T,
    maxTokens = 1200,
    /** When set, malformed JSON is salvaged into `{ [salvageKey]: string[] }`. */
    salvageKey?: string
  ): Promise<T> {
    const raw = await this.ask(
      `${system}\n\nRespond with JSON only. No prose, no markdown fences.`,
      user,
      maxTokens
    );

    const candidates = [
      raw,
      raw.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1],
      raw.match(/(\{[\s\S]*\})/)?.[1],
      raw.match(/(\[[\s\S]*\])/)?.[1],
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate.trim());
        // A bare array where an object was expected is a common near-miss.
        if (salvageKey && Array.isArray(parsed)) {
          return { [salvageKey]: parsed } as unknown as T;
        }
        return parsed as T;
      } catch {
        /* try the next shape */
      }
    }

    // Salvage: small models emit `{"a", "b"}` instead of `{"key": ["a", "b"]}`.
    // The strings are right, only the container is wrong, so pull them out
    // rather than discarding a whole source's worth of work.
    if (salvageKey) {
      const strings = Array.from(raw.matchAll(/"((?:[^"\\]|\\.){20,})"/g))
        .map((m) => m[1].replace(/\\"/g, '"').trim())
        .filter((s) => s.length > 20 && !/^https?:\/\//.test(s));

      if (strings.length > 0) {
        debugLog("research-json-salvaged", { key: salvageKey, count: strings.length });
        return { [salvageKey]: strings } as unknown as T;
      }
    }

    debugLog("research-json-parse-failed", { raw: raw.slice(0, 400) });
    return fallback;
  }

  // -------------------------------------------------------------------------
  // Stage 1: decompose
  // -------------------------------------------------------------------------
  private async decompose(topic: string, budget: Budget): Promise<string[]> {
    this.status("decompose", `Breaking the topic into ${budget.subQuestions} sub-questions…`);

    const parsed = await this.askJson<{ questions?: string[] }>(
      "You are a research planner. Break a topic into distinct, independently searchable " +
        "sub-questions. Each must target a different aspect — no rephrasings of each other. " +
        "Each must be a real question containing real words from or about the topic.",
      `Topic: ${topic}\n\nProduce exactly ${budget.subQuestions} sub-questions.\n\n` +
        `Example for the topic "Rust async runtimes":\n` +
        `{"questions": ["What is the difference between tokio and async-std?", ` +
        `"Which Rust async runtime has the best performance benchmarks?"]}\n\n` +
        `Now do the same for "${topic}".`,
      {},
      1200,
      "questions"
    );

    // Small models copy placeholder text out of the example verbatim. A question
    // of "..." searched literally returns pages about the ellipsis character, so
    // anything that isn't a real query is discarded here.
    const usable = (parsed.questions ?? [])
      .filter((q): q is string => typeof q === "string")
      .map((q) => q.trim())
      .filter((q) => {
        if (q.length < 12) return false;
        // Must contain at least two words of three or more letters.
        const words = q.match(/[A-Za-z]{3,}/g) ?? [];
        if (words.length < 2) return false;
        // Reject leftover placeholders.
        if (/^[.…\s?_-]+$/.test(q)) return false;
        if (/^(first|second|third|another)?\s*(sub-?)?question/i.test(q)) return false;
        return true;
      });

    let questions = Array.from(new Set(usable)).slice(0, budget.subQuestions);

    if (questions.length === 0) {
      // Planning failed — research the topic verbatim rather than aborting.
      this.warnings.push(
        "The model produced no usable sub-questions, so the topic was searched verbatim. " +
          "Smaller models often fail this step; try /effort high or a larger model."
      );
      questions = [topic];
    } else if (questions.length < budget.subQuestions) {
      // Always keep the raw topic in the mix as a safety net.
      if (!questions.includes(topic)) questions.push(topic);
    }

    this.status("decompose", `${questions.length} sub-question(s) planned.`, { questions });
    return questions;
  }

  // -------------------------------------------------------------------------
  // Stage 2: search
  // -------------------------------------------------------------------------
  private async gatherResults(questions: string[], budget: Budget): Promise<SearchResult[]> {
    this.status("search", `Searching ${questions.length} query/queries via ${activeSearchBackend()}…`);

    const outcomes = await Promise.all(
      questions.map((q) => webSearch(q, budget.resultsPerQuestion))
    );

    const pooled: SearchResult[] = [];
    const seenUrls = new Set<string>();
    const seenHosts = new Map<string, number>();

    for (const outcome of outcomes) {
      if (outcome.error) {
        this.warnings.push(`Search for "${outcome.query}" failed: ${outcome.error}`);
        continue;
      }

      for (const result of outcome.results) {
        if (seenUrls.has(result.url)) continue;

        // Cap per-host so one site can't dominate the source pool.
        let host = "";
        try {
          host = new URL(result.url).hostname.replace(/^www\./, "");
        } catch {
          continue;
        }
        const fromHost = seenHosts.get(host) ?? 0;
        if (fromHost >= 2) continue;

        seenUrls.add(result.url);
        seenHosts.set(host, fromHost + 1);
        pooled.push(result);
      }
    }

    if (pooled.length === 0) {
      throw new AssistantError(
        "No search results could be retrieved, so there is nothing to research.",
        activeSearchBackend() === "duckduckgo"
          ? "DuckDuckGo scraping may be rate-limited. Wait a minute, or set BRAVE_SEARCH_API_KEY / TAVILY_API_KEY."
          : "Check your search API key and network connection."
      );
    }

    this.status("search", `${pooled.length} unique result(s) across ${seenHosts.size} site(s).`);
    return pooled;
  }

  // -------------------------------------------------------------------------
  // Stage 3: read
  // -------------------------------------------------------------------------
  private async readSources(
    pooled: SearchResult[],
    budget: Budget
  ): Promise<Array<ResearchSource & { text: string }>> {
    const shortlist = pooled.slice(0, budget.sourcesToRead * 2);
    this.status("read", `Fetching up to ${budget.sourcesToRead} source(s)…`);

    const sources: Array<ResearchSource & { text: string }> = [];

    // Fetch in small waves: enough parallelism to be quick, not enough to look
    // like an attack on any one host.
    for (let i = 0; i < shortlist.length && sources.length < budget.sourcesToRead; i += 3) {
      const wave = shortlist.slice(i, i + 3);
      const pages = await Promise.all(wave.map((r) => fetchPage(r.url)));

      for (let j = 0; j < pages.length; j++) {
        const page = pages[j];

        if (page.error) {
          this.warnings.push(`Could not read ${wave[j].url}: ${page.error}`);
          continue;
        }
        // Too little text to be a real article.
        if (page.text.length < 400) {
          this.warnings.push(`Skipped ${page.url}: too little readable text (${page.text.length} chars).`);
          continue;
        }
        if (sources.length >= budget.sourcesToRead) break;

        const source = {
          index: sources.length + 1,
          url: page.url,
          title: page.title || wave[j].title,
          chars: page.chars,
          truncated: page.truncated,
          text: page.text,
        };
        sources.push(source);
        this.status("read", `[${source.index}] ${source.title}`, { url: source.url });
      }
    }

    if (sources.length === 0) {
      throw new AssistantError(
        "Search returned results, but none of the pages could be read.",
        "Sites may be blocking automated fetches. Try a narrower topic, or set TAVILY_API_KEY."
      );
    }

    return sources;
  }

  // -------------------------------------------------------------------------
  // Stage 4: extract claims
  // -------------------------------------------------------------------------
  private async extractClaims(
    sources: Array<ResearchSource & { text: string }>,
    topic: string,
    budget: Budget
  ): Promise<ResearchClaim[]> {
    this.status("extract", `Extracting claims from ${sources.length} source(s)…`);

    const claims: ResearchClaim[] = [];

    for (const source of sources) {
      const parsed = await this.askJson<{ claims?: string[] }>(
        "You extract factual claims from a source document. A claim must be a single, " +
          "checkable statement that is actually present in the text. Never infer, never add " +
          "outside knowledge. If the text is irrelevant to the topic, return an empty list.",
        `Topic: ${topic}\n\nSource [${source.index}] ${source.title}\n` +
          `URL: ${source.url}\n\n` +
          // Wrapped after slicing: slicing a wrapped block could cut the closing
          // delimiter and leave the boundary open.
          `${wrapUntrusted(source.text.slice(0, 6000), sourceLabel(source.url))}\n\n` +
          `Extract at most ${budget.claimsPerSource} claims relevant to the topic. Each claim ` +
          `must be a complete sentence quoting or closely paraphrasing the source.\n\n` +
          `Example shape (do NOT copy this content):\n` +
          `{"claims": ["Tokio uses a multi-threaded work-stealing scheduler by default."]}\n\n` +
          `If nothing in the text relates to the topic, return {"claims": []}.`,
        {},
        900,
        "claims"
      );

      const extracted = (parsed.claims ?? [])
        .filter((c): c is string => typeof c === "string")
        .map((c) => c.trim())
        // Same placeholder guard as decompose: require real sentences.
        .filter((c) => c.length > 20 && (c.match(/[A-Za-z]{3,}/g) ?? []).length >= 4)
        .filter((c) => !/^[.…\s]+$/.test(c))
        .slice(0, budget.claimsPerSource);

      for (const text of extracted) {
        claims.push({ text: text.trim(), sourceIndex: source.index, verdict: "supported" });
      }

      this.status("extract", `[${source.index}] ${extracted.length} claim(s).`, {
        done: source.index,
        total: sources.length,
      });
    }

    if (claims.length === 0) {
      this.warnings.push(
        "No claims could be extracted from any source. The report below is therefore thin — " +
          "usually a sign the topic and the sources did not match."
      );
    }

    return claims;
  }

  // -------------------------------------------------------------------------
  // Stage 5: adversarial verification
  // -------------------------------------------------------------------------
  private async verifyClaims(
    claims: ResearchClaim[],
    sources: Array<ResearchSource & { text: string }>,
    budget: Budget
  ): Promise<ResearchClaim[]> {
    const toVerify = claims.slice(0, budget.verifyClaims);

    if (toVerify.length < claims.length) {
      this.warnings.push(
        `Verified ${toVerify.length} of ${claims.length} claims (limited by /effort ` +
          `${getSettings().effort}). Unverified claims are excluded from the report.`
      );
    }

    this.status("verify", `Adversarially checking ${toVerify.length} claim(s)…`);

    const verified: ResearchClaim[] = [];

    for (let i = 0; i < toVerify.length; i++) {
      const claim = toVerify[i];
      const origin = sources.find((s) => s.index === claim.sourceIndex);

      // Show the claim's own source plus the others, so contradictions surface.
      const others = sources
        .filter((s) => s.index !== claim.sourceIndex)
        .slice(0, 3)
        .map(
          (s) =>
            `[${s.index}] ${s.title}\n${wrapUntrusted(s.text.slice(0, 1500), sourceLabel(s.url))}`
        )
        .join("\n\n");

      const parsed = await this.askJson<{ verdict?: string; reason?: string }>(
        "You are a skeptical fact-checker. Your default is to REJECT a claim unless the " +
          "source text plainly states it. Reject anything embellished, generalised beyond the " +
          "text, or contradicted elsewhere. Being wrong in favour of a claim is worse than " +
          "rejecting a true one.",
        `Claim: "${claim.text}"\n\n` +
          `Its source [${claim.sourceIndex}] ${origin?.title ?? "unknown"}:\n` +
          `${wrapUntrusted(
            (origin?.text ?? "").slice(0, 3000),
            origin ? sourceLabel(origin.url) : "unknown source"
          )}\n\n` +
          // Bounded by taking fewer sources rather than slicing the joined
          // string: a blind slice can cut through a delimiter and leave the
          // untrusted region open.
          `Other sources:\n${others}\n\n` +
          `Answer: is the claim directly stated by its own source, and not contradicted by the others?\n` +
          `Format: {"verdict": "supported" | "unsupported" | "contested", "reason": "one sentence"}`,
        { verdict: "unsupported", reason: "Verification produced no parseable verdict." },
        400
      );

      const verdict =
        parsed.verdict === "supported" || parsed.verdict === "contested"
          ? parsed.verdict
          : "unsupported";

      verified.push({ ...claim, verdict, reason: parsed.reason });
      this.status("verify", `${i + 1}/${toVerify.length} — ${verdict}`, {
        done: i + 1,
        total: toVerify.length,
      });
    }

    return verified;
  }

  // -------------------------------------------------------------------------
  // Stage 6: synthesize
  // -------------------------------------------------------------------------
  private async synthesize(
    topic: string,
    claims: ResearchClaim[],
    sources: Array<ResearchSource & { text: string }>
  ): Promise<string> {
    const supported = claims.filter((c) => c.verdict === "supported");
    const contested = claims.filter((c) => c.verdict === "contested");

    this.status(
      "synthesize",
      `Writing the report from ${supported.length} supported and ${contested.length} contested claim(s)…`
    );

    if (supported.length === 0 && contested.length === 0) {
      return (
        `## ${topic}\n\n**No verified findings.**\n\n` +
        `${sources.length} source(s) were read, but no claim survived verification. ` +
        `That means the sources did not plainly support anything about this topic — not that ` +
        `the topic is unanswerable. Try narrowing it, or raise \`/effort high\` for a wider sweep.\n\n` +
        `### Sources consulted\n` +
        sources.map((s) => `${s.index}. [${s.title}](${s.url})`).join("\n")
      );
    }

    const claimBlock = [
      ...supported.map((c) => `SUPPORTED [${c.sourceIndex}]: ${c.text}`),
      ...contested.map((c) => `CONTESTED [${c.sourceIndex}]: ${c.text} (${c.reason ?? ""})`),
    ].join("\n");

    const style =
      getSettings().outputStyle === "adhd"
        ? "Style: lead with the answer. Numbered points, max 5 per list. No preamble or closing filler."
        : "Style: clear prose with short sections.";

    const body = await this.ask(
      "You write research briefings from pre-verified claims. Absolute rules:\n" +
        "1. Use ONLY the claims given. Add nothing from your own knowledge.\n" +
        "2. Cite every factual sentence with its source number, like [2].\n" +
        "3. Flag contested claims explicitly as disputed.\n" +
        "4. State what remains unknown.\n" +
        `5. ${style}`,
      `Topic: ${topic}\n\nVerified claims:\n${claimBlock}\n\n` +
        `Sources:\n${sources.map((s) => `[${s.index}] ${s.title} — ${s.url}`).join("\n")}\n\n` +
        `Write the briefing. Start with a two-sentence answer, then the detail, then ` +
        `"What's still unclear".`,
      1800
    );

    const sourceList = sources.map((s) => `${s.index}. [${s.title}](${s.url})`).join("\n");

    return `${body.trim()}\n\n### Sources\n${sourceList}`;
  }

  // -------------------------------------------------------------------------
  // Orchestration
  // -------------------------------------------------------------------------
  public async run(topic: string): Promise<ResearchReport> {
    const cleanTopic = topic.trim();
    if (!cleanTopic) {
      throw new AssistantError(
        "No research topic given.",
        "Use `/deep-research <topic or question>`."
      );
    }

    const effort = getSettings().effort;
    const budget = budgetFor(effort);

    this.status("start", `Researching at /effort ${effort} using ${this.model}.`, {
      budget,
      backend: activeSearchBackend(),
    });

    const subQuestions = await this.decompose(cleanTopic, budget);
    const pooled = await this.gatherResults(subQuestions, budget);
    const sources = await this.readSources(pooled, budget);
    const rawClaims = await this.extractClaims(sources, cleanTopic, budget);
    const claims = await this.verifyClaims(rawClaims, sources, budget);
    const report = await this.synthesize(cleanTopic, claims, sources);

    this.status("done", "Research complete.");

    return {
      topic: cleanTopic,
      backend: activeSearchBackend(),
      subQuestions,
      sources: sources.map(({ text, ...rest }) => rest),
      claims,
      report,
      usage: { ...this.usage },
      warnings: this.warnings,
    };
  }
}
