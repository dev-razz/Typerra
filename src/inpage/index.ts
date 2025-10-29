// In-page script: runs in the page's JS context so it can access built-in AI APIs (Writer, Rewriter, Proofreader)
// Communicates with content script via window.postMessage

// Types are not available here; we use any and feature-detect
export {};

type GXRequest = { id: number; method: string; params: any };

declare global {
  interface Window {
    Rewriter?: any;
    Writer?: any;
    Proofreader?: any;
    __GX_WARMUP_STARTED__?: boolean;
  }
}

function postResponse(id: number, result?: any, error?: string) {
  window.postMessage({ __gx: true, direction: 'inpage->cs', id, result, error }, '*');
}

async function ensureAvailability(Cls: any): Promise<'available' | 'downloadable' | 'unavailable'> {
  if (!Cls || typeof Cls.availability !== 'function') {
  console.warn('[Typerra][INPAGE] API class missing or has no availability');
    return 'unavailable';
  }
  try {
    const a = await Cls.availability();
  console.log('[Typerra][INPAGE] availability:', a);
    return a;
  } catch (e) {
  console.error('[Typerra][INPAGE] availability check failed', e);
    return 'unavailable';
  }
}

let cachedWriter: any | null = null;
let cachedRewriter: any | null = null;
let cachedProofreader: any | null = null;

function safeDispose(obj: any) {
  try {
    if (!obj) return;
    if (typeof obj.dispose === 'function') { obj.dispose(); return; }
    if (typeof obj.close === 'function') { obj.close(); return; }
    if (typeof obj.destroy === 'function') { obj.destroy(); return; }
    if (typeof obj.abort === 'function') { obj.abort(); return; }
  } catch {}
}

function disposeModels() {
  try { safeDispose(cachedWriter); } catch {}
  try { safeDispose(cachedRewriter); } catch {}
  try { safeDispose(cachedProofreader); } catch {}
  cachedWriter = null;
  cachedRewriter = null;
  cachedProofreader = null;
}

function disposeNonProofreader() {
  try { safeDispose(cachedWriter); } catch {}
  try { safeDispose(cachedRewriter); } catch {}
  cachedWriter = null;
  cachedRewriter = null;
  // Keep proofreader instance in memory
}

// Build a standardized proofread payload from various API result shapes
function buildProofreadPayload(base: string, apiResult: any): { corrected: string; corrections: any[]; ranges: Array<{ start: number; end: number; replacement?: string }> } {
  const corrections: any[] = Array.isArray(apiResult?.corrections) ? apiResult.corrections : [];
  let corrected: string = String(apiResult?.corrected || apiResult?.text || '');
  let ranges: Array<{ start: number; end: number; replacement?: string }> = [];

  // Normalize ranges for consumers (correction spans)
  try {
    type Corr = { start?: number; end?: number; range?: { start?: number; end?: number }; offset?: number; length?: number; replacement?: string; replacementText?: string; suggestions?: any[]; suggestion?: string; text?: string; correction?: string };
    ranges = (corrections as Corr[])
      .map((c) => {
        const start = (typeof c.start === 'number') ? c.start
          : (typeof c.offset === 'number') ? c.offset
          : (typeof (c as any).startIndex === 'number') ? (c as any).startIndex
          : (typeof c.range?.start === 'number') ? c.range!.start
          : (typeof (c as any).rangeStart === 'number') ? (c as any).rangeStart
          : undefined;
        const end = (typeof c.end === 'number') ? c.end
          : (typeof (c as any).endIndex === 'number') ? (c as any).endIndex
          : (typeof c.length === 'number' && typeof start === 'number') ? start + c.length
          : (typeof c.range?.end === 'number') ? c.range!.end
          : (typeof (c as any).rangeEnd === 'number') ? (c as any).rangeEnd
          : undefined;
        const repl = (typeof (c as any).correction === 'string') ? (c as any).correction
          : (typeof c.replacement === 'string') ? c.replacement
          : (typeof c.replacementText === 'string') ? c.replacementText
          : (typeof c.suggestion === 'string') ? c.suggestion
          : (Array.isArray(c.suggestions) && c.suggestions.length && typeof c.suggestions[0]?.replacement === 'string') ? c.suggestions[0].replacement
          : (Array.isArray(c.suggestions) && c.suggestions.length && typeof c.suggestions[0]?.text === 'string') ? c.suggestions[0].text
          : undefined;
        return (typeof start === 'number' && typeof end === 'number') ? { start, end, replacement: repl } : null;
      })
      .filter(Boolean) as Array<{ start: number; end: number; replacement?: string }>;
  } catch (e) {
  console.warn('[Typerra][INPAGE] Failed to normalize ranges', e);
    ranges = [];
  }

  // If corrected text missing, attempt to synthesize using ranges
  if (!corrected && ranges.length > 0) {
    try {
      const normalized = [...ranges].sort((a, b) => b.start - a.start);
      let out = base;
      for (const corr of normalized) {
        const s = Math.max(0, Math.min(out.length, corr.start));
        const e = Math.max(s, Math.min(out.length, corr.end));
        out = out.slice(0, s) + (typeof corr.replacement === 'string' ? corr.replacement : out.slice(s, e)) + out.slice(e);
      }
      corrected = out;
    } catch (e) {
  console.warn('[Typerra][INPAGE] Failed to derive corrected text from corrections', e);
    }
  }

  if (!corrected) corrected = base;
  return { corrected, corrections, ranges };
}

async function getWriter(options: any = {}): Promise<any> {
  if (cachedWriter) return cachedWriter;
  const avail = await ensureAvailability((window as any).Writer);
  if (avail === 'unavailable') throw new Error('Writer API unavailable in this browser.');
  cachedWriter = await (window as any).Writer.create({
    ...options,
    monitor(m: any) {
      m.addEventListener('downloadprogress', (e: any) => {
        // Optionally forward progress
        // console.log('Writer download', e.loaded, e.total);
      });
    },
    expectedInputLanguages: ['en'],
    expectedContextLanguages: ['en'],
    outputLanguage: 'en',
  });
  return cachedWriter;
}

async function getRewriter(options: any = {}): Promise<any> {
  if (cachedRewriter) return cachedRewriter;
  const avail = await ensureAvailability((window as any).Rewriter);
  if (avail === 'unavailable') throw new Error('Rewriter API unavailable in this browser.');
  cachedRewriter = await (window as any).Rewriter.create({
    ...options,
    monitor(m: any) {
      m.addEventListener('downloadprogress', (e: any) => {
        // console.log('Rewriter download', e.loaded, e.total);
      });
    },
    expectedInputLanguages: ['en'],
    expectedContextLanguages: ['en'],
    outputLanguage: 'en',
  });
  return cachedRewriter;
}

async function getProofreader(options: any = {}): Promise<any> {
  if (cachedProofreader) return cachedProofreader;
  const avail = await ensureAvailability((window as any).Proofreader);
  if (avail === 'unavailable') throw new Error('Proofreader API unavailable in this browser.');
  cachedProofreader = await (window as any).Proofreader.create({
    ...options,
    monitor(m: any) {
      m.addEventListener('downloadprogress', (e: any) => {
        try {
          const { loaded, total } = e || {};
          console.log('[Typerra][INPAGE] Proofreader download progress', loaded, '/', total);
        } catch {}
      });
    },
    expectedInputLanguages: ['en']
  });
  return cachedProofreader;
}

function mapWriterTone(t: string | undefined) {
  if (!t) return undefined;
  if (t === 'neutral' || t === 'casual' || t === 'formal') return t;
  return undefined;
}
function mapWriterLength(l: string | undefined) {
  if (!l) return undefined;
  if (l === 'short' || l === 'medium' || l === 'long') return l;
  return undefined;
}
function mapRewriterTone(t: string | undefined) {
  if (!t) return undefined;
  if (t === 'more-casual' || t === 'as-is' || t === 'more-formal') return t;
  return undefined;
}
function mapRewriterLength(l: string | undefined) {
  if (!l) return undefined;
  if (l === 'shorter' || l === 'as-is' || l === 'longer') return l;
  return undefined;
}

async function handle(method: string, params: any) {
  switch (method) {
    case 'warmup': {
      await warmupModels();
      return { ok: true };
    }
    case 'ensure': {
      const which = String(params?.model || '').toLowerCase();
      if (which === 'proofreader') { await getProofreader(); return { ok: true, model: 'proofreader' }; }
      if (which === 'writer') { await getWriter(); return { ok: true, model: 'writer' }; }
      if (which === 'rewriter') { await getRewriter(); return { ok: true, model: 'rewriter' }; }
      throw new Error('Unknown model: ' + which);
    }
    case 'dispose': {
      disposeModels();
      return { ok: true };
    }
    case 'disposeNonProofreader': {
      disposeNonProofreader();
      return { ok: true };
    }
    case 'write': {
      const { prompt, tone, length } = params || {};
      const writer = await getWriter({ tone: mapWriterTone(tone), length: mapWriterLength(length) });
      const res = await writer.write(String(prompt || ''));
      return String(res);
    }
    case 'rewrite': {
      const { text, tone, length, context } = params || {};
      const rewriter = await getRewriter({ tone: mapRewriterTone(tone), length: mapRewriterLength(length) });
      const instruction = String(
        context ||
        'Only rewrite the provided text according to the requested tone/length. Preserve the original meaning and information. Do not add new ideas, remove content, or include explanations. Return only the rewritten text.'
      );
      const res = await rewriter.rewrite(String(text || ''), { context: instruction });
      return String(res).trim();
    }
    case 'proofread': {
      const { text } = params || {};
      const proofreader = await getProofreader();
      const base = String(text || '');
      try {
        const result = await proofreader.proofread(base);
        const payload = buildProofreadPayload(base, result);
  // console.log('[Typerra][INPAGE] Proofread response', { correctedLen: (payload.corrected || '').length, corrections: Array.isArray(payload.corrections) ? payload.corrections.length : 'n/a' });
        return payload;
      } catch (e: any) {
        const msg = (e?.message || e || '').toString().toLowerCase();
        const name = (e?.name || '').toString().toLowerCase();
        if (name === 'aborterror' || msg.includes('cancel')) {
          // Gracefully signal cancellation to content script without throwing
          return { corrected: base, corrections: [], ranges: [], cancelled: true } as any;
        }
        throw e;
      }
    }
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

window.addEventListener('message', async (evt) => {
  const data = evt.data;
  if (!data || data.__gx !== true || data.direction !== 'cs->inpage') return;
  const { id, method, params } = data as GXRequest & { __gx: true };
  try {
    const result = await handle(method, params);
    postResponse(id, result);
  } catch (e: any) {
    postResponse(id, undefined, e?.message || String(e));
  }
});

// Warmup models on script load (once per page)
let warmupRunning = false;
async function warmupModels() {
  if (warmupRunning || (window as any).__GX_WARMUP_STARTED__) return;
  warmupRunning = true;
  (window as any).__GX_WARMUP_STARTED__ = true;
  try {
    await Promise.all([
  getProofreader().catch((e) => console.warn('[Typerra][INPAGE] Proofreader warmup skipped', e?.message || e)),
  getRewriter().catch((e) => console.warn('[Typerra][INPAGE] Rewriter warmup skipped', e?.message || e)),
  getWriter().catch((e) => console.warn('[Typerra][INPAGE] Writer warmup skipped', e?.message || e)),
    ]);
  console.log('[Typerra][INPAGE] Warmup done');
  } catch (e) {
  console.warn('[Typerra][INPAGE] Warmup error', e);
  } finally {
    warmupRunning = false;
  }
}

// Defer a tick so page settles before starting downloads
// NOTE: Avoid eager warmup to reduce per-tab RAM usage.
// The models will be created lazily on first use (proofread/rewrite/write).
// You can still trigger warmup explicitly from the content script via callInpage('warmup').
try { /* warmup deferred until explicitly requested */ } catch {}
