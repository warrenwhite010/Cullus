// Asking the user a question mid-turn.
//
// The model needs a way to get a decision without ending the turn. Without one it
// does the only thing it can: writes "which would you prefer?" as its final
// answer and stops — losing the whole tool loop, and forcing the user to restate
// context in a fresh message.
//
// Shaped like approval.ts, and for the same reasons: the surface that drives the
// turn (a socket, the terminal) registers a handler, and the loop only knows how
// to await one. Three rules keep it safe in the middle of a loop:
//
//   1. No handler registered → the question is UNANSWERED, not blocking. A
//      headless run (cron, a fan-out worker) must not deadlock on a prompt no
//      one can see; the model is told to pick a sane default and say what it
//      assumed.
//   2. Every question times out, and a timeout reads as "no answer", never as an
//      error that kills the turn.
//   3. The answer is data, not control: whatever comes back is handed to the
//      model as a tool result, so a free-text reply works as well as a pick.

export interface InquiryOption {
  /** Short label shown in the list. */
  label: string;
  /** Optional one-liner explaining the consequence of picking it. */
  description?: string;
}

export interface InquiryRequest {
  id: string;
  question: string;
  options: InquiryOption[];
  /** True when the user may type something instead of picking. */
  allowFreeText: boolean;
  /** True when more than one option may be chosen. */
  multiSelect: boolean;
}

export interface InquiryOutcome {
  /** Labels the user chose, in the order shown. */
  chosen: string[];
  /** Anything the user typed instead of, or alongside, picking. */
  text?: string;
  /** Set when nobody was listening, or nobody answered in time. */
  unanswered?: boolean;
  reason?: string;
}

export type InquiryHandler = (request: InquiryRequest) => Promise<InquiryOutcome>;

/** How long to wait for a human before giving up on the question. */
const INQUIRY_TIMEOUT_MS = Number((process.env.CULLUS_INQUIRY_TIMEOUT_MS ?? process.env.ASSISTANT_INQUIRY_TIMEOUT_MS) ?? 600_000);

let handler: InquiryHandler | null = null;
let counter = 0;

export function setInquiryHandler(next: InquiryHandler | null): void {
  handler = next;
}

export function hasInquiryHandler(): boolean {
  return handler !== null;
}

/**
 * Put a question to the user and wait for the answer.
 *
 * Never throws and never hangs: a missing handler, a rejected handler and a
 * timeout all resolve to `unanswered`, because the caller is a tool inside an
 * inference loop and any of those turning into an exception would abort work the
 * user asked for.
 */
export async function askUser(
  question: string,
  options: InquiryOption[],
  opts: { allowFreeText?: boolean; multiSelect?: boolean } = {}
): Promise<InquiryOutcome> {
  if (!handler) {
    return {
      chosen: [],
      unanswered: true,
      reason: "nothing is listening for questions in this run",
    };
  }

  const request: InquiryRequest = {
    id: `q${++counter}-${Date.now()}`,
    question,
    options,
    allowFreeText: opts.allowFreeText !== false,
    multiSelect: opts.multiSelect === true,
  };

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      handler(request),
      new Promise<InquiryOutcome>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              chosen: [],
              unanswered: true,
              reason: `no answer within ${Math.round(INQUIRY_TIMEOUT_MS / 1000)}s`,
            }),
          INQUIRY_TIMEOUT_MS
        );
      }),
    ]);
  } catch (err: any) {
    return {
      chosen: [],
      unanswered: true,
      reason: `the question could not be delivered (${err?.message ?? "unknown error"})`,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
