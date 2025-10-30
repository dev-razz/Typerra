import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

// Lazy-load the in-page script only when we first need it (reduces per-tab RAM)
let inpageReady: Promise<void> | null = null;
function ensureInpage(): Promise<void> {
  const id = 'typerra-inpage';
  if (document.getElementById(id)) return Promise.resolve();
  if (inpageReady) return inpageReady;
  inpageReady = new Promise<void>((resolve) => {
    const script = document.createElement('script');
    script.id = id;
    script.src = chrome.runtime.getURL('assets/inpage.js');
    script.type = 'module';
    (document.head || document.documentElement).appendChild(script);
    script.onload = () => { try { script.remove(); } catch {} resolve(); };
    script.onerror = () => { resolve(); };
  });
  return inpageReady;
}

// Simple RPC layer between content script and in-page script via window.postMessage
let reqCounter = 1;
const pending = new Map<number, { resolve: (value: any) => void; reject: (reason?: any) => void }>();

window.addEventListener('message', (evt) => {
  const data = evt.data;
  if (!data || data.__gx !== true || data.direction !== 'inpage->cs') return;
  const { id, result, error } = data;
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  if (error) {
    // Only warn if it's not a benign cancellation
    const msg = String(error).toLowerCase();
  if (!msg.includes('cancel')) console.warn('Typerra inpage error:', error);
    entry.reject(new Error(error));
  } else {
    entry.resolve(result);
  }
});

// Lightweight heartbeat: if inpage bridge is present, send a ping periodically so the page-side
// script can detect extension activity. If the extension is disabled/removed or the content script
// goes away, heartbeats stop and the inpage script self-disposes to free memory.
try {
  const HB_MARK = '__TYPERRA_HEARTBEAT__';
  const w = window as any;
  if (!w[HB_MARK]) {
    w[HB_MARK] = true;
    const HEARTBEAT_INTERVAL_MS = 15_000; // match inpage check cadence
    const t = setInterval(() => {
      try {
        if (document.getElementById('typerra-inpage')) {
          // Fire-and-forget ping (do not ensure/inject)
          window.postMessage({ __gx: true, direction: 'cs->inpage', id: 0, method: 'ping', params: {} }, '*');
        }
      } catch {}
    }, HEARTBEAT_INTERVAL_MS);
    // Clean up on navigation
    window.addEventListener('beforeunload', () => { try { clearInterval(t); } catch {} }, { once: true });
    window.addEventListener('pagehide', () => { try { clearInterval(t); } catch {} }, { once: true });
  }
} catch {}

async function callInpage<T = any>(method: string, params: any): Promise<T> {
  // Ensure the in-page bridge is present before posting
  try { await ensureInpage(); } catch {}
  const id = reqCounter++;
  const p = new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: (value) => resolve(value as T), reject });
    // Timeout safety
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('In-page call timed out'));
      }
    }, 60000);
  });
  window.postMessage({ __gx: true, direction: 'cs->inpage', id, method, params }, '*');
  return p;
}

// Utilities to work with editable elements
function isEditable(el: Element | null): el is HTMLElement {
  if (!el) return false;
  const anyEl = el as any;
  if ((el as HTMLElement).isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement && (el.type === 'text' || el.type === 'search' || el.type === 'email' || el.type === 'url' || el.type === 'tel')) return true;
  // Some custom editors may use role
  if (el.getAttribute('role') === 'textbox') return true;
  return false;
}

function getActiveEditable(): HTMLElement | null {
  const active = document.activeElement as HTMLElement | null;
  if (isEditable(active)) return active;
  // Fallback: if selection is within a contentEditable, use the closest ancestor
  try {
    const sel = document.getSelection();
    const anchor = sel?.anchorNode || null;
    if (anchor) {
      let n: Node | null = anchor;
      while (n) {
        if (n instanceof HTMLElement && n.isContentEditable) return n;
        n = (n as Node).parentNode;
      }
    }
  } catch {}
  // Gmail compose: attempt to locate the message body editor explicitly
  if (IS_GMAIL) {
    const body = document.querySelector('div[aria-label="Message Body"][contenteditable="true"]') as HTMLElement | null;
    if (body) return body;
  }
  return null;
}

// Small helpers and constants
const MARGIN = 8;
const PANEL_MIN_W = 220;
const PANEL_MAX_W = 440;
const PANEL_MAX_VH = 0.7;
const BUBBLE = 28;
const BASE_FONT = 13;
const SMALL_FONT = 10;
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
// Host feature flags
const IS_GOOGLE_DOCS = typeof location !== 'undefined' && /(^|\.)docs\.google\.com$/.test(location.hostname);
const IS_GMAIL = typeof location !== 'undefined' && /(^|\.)mail\.google\.com$/.test(location.hostname);
// Performance guards
const MAX_REALTIME_CHARS = 2000; // disable realtime proofread and overlay beyond this size
const MIN_INTERVAL_MS = 700; // minimum time between consecutive proofread calls

// Types for in-page proofread payload with ranges
type ProofreadRange = { start: number; end: number; replacement?: string };
type ProofreadPayload = { corrected: string; corrections: any[]; ranges?: ProofreadRange[]; cancelled?: boolean };

// Get full text from an editable element
function getEditableText(el: HTMLElement): string {
  return (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) ? el.value : el.innerText || '';
}

// Create an overlay to draw red underlines for incorrect ranges without mutating the DOM
function createUnderlineOverlay(target: HTMLElement) {
  const overlay = document.createElement('div');
  overlay.style.position = 'fixed';
  overlay.style.pointerEvents = 'none';
  overlay.style.inset = '0 0 auto auto'; // will set top/left/width/height below
  overlay.style.zIndex = '2147483646';
  overlay.style.overflow = 'hidden';
  overlay.style.background = 'transparent';

  const content = document.createElement('div');
  content.style.position = 'absolute';
  content.style.whiteSpace = 'pre-wrap';
  content.style.wordBreak = 'break-word';
  content.style.color = 'transparent';
  // For Safari/WebKit to ensure transparency
  (content.style as any).WebkitTextFillColor = 'transparent';
  overlay.appendChild(content);

  const applyComputedStyles = () => {
    const cs = getComputedStyle(target);
    const rect = target.getBoundingClientRect();
    overlay.style.top = `${rect.top}px`;
    overlay.style.left = `${rect.left}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;

    content.style.font = cs.font; // shorthand includes font-style, weight, size, family
    content.style.lineHeight = cs.lineHeight;
    content.style.letterSpacing = cs.letterSpacing;
    content.style.paddingTop = cs.paddingTop;
    content.style.paddingRight = cs.paddingRight;
    content.style.paddingBottom = cs.paddingBottom;
    content.style.paddingLeft = cs.paddingLeft;
  };

  const syncScroll = () => {
    const st = (target as any).scrollTop || 0;
    const sl = (target as any).scrollLeft || 0;
    content.style.transform = `translate(${-sl}px, ${-st}px)`;
  };

  let mounted = false;
  const mount = () => {
    if (mounted) return;
    mounted = true;
    document.documentElement.appendChild(overlay);
    applyComputedStyles();
    syncScroll();
  };
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    overlay.remove();
    ro.disconnect();
    window.removeEventListener('resize', onLayout, true);
    window.removeEventListener('scroll', onLayout, true);
    target.removeEventListener('scroll', onScroll, true);
  };

  const onLayout = () => { applyComputedStyles(); };
  const onScroll = () => { syncScroll(); };

  const ro = new ResizeObserver(() => applyComputedStyles());

  let spanNodes: Array<{ node: HTMLSpanElement; start: number; end: number; underline: boolean }> = [];
  const render = (text: string, ranges: ProofreadRange[] = []) => {
    // Clear content
    while (content.firstChild) content.removeChild(content.firstChild);
    spanNodes = [];
    if (!text) return;
    const segments: Array<{ start: number; end: number; underline: boolean }> = [];
    const sorted = [...ranges].sort((a, b) => a.start - b.start);
    let idx = 0;
    for (const r of sorted) {
      const s = Math.max(0, Math.min(text.length, r.start));
      const e = Math.max(s, Math.min(text.length, r.end));
      if (idx < s) segments.push({ start: idx, end: s, underline: false });
      if (s < e) segments.push({ start: s, end: e, underline: true });
      idx = e;
    }
    if (idx < text.length) segments.push({ start: idx, end: text.length, underline: false });

    for (const seg of segments) {
      const t = text.slice(seg.start, seg.end);
      if (!t) continue;
      const span = document.createElement('span');
      // Keep text invisible; only underline spans will show decoration
      if (seg.underline) {
        span.style.textDecoration = 'underline';
        (span.style as any).textDecorationStyle = 'solid';
        (span.style as any).textDecorationColor = '#ef4444';
        // span.style.textDecorationThickness = '2px'; // optional
      }
      span.dataset.start = String(seg.start);
      span.dataset.end = String(seg.end);
      span.textContent = t;
      content.appendChild(span);
      spanNodes.push({ node: span, start: seg.start, end: seg.end, underline: seg.underline });
    }
  };

  const attach = () => {
    mount();
    ro.observe(target);
    window.addEventListener('resize', onLayout, true);
    window.addEventListener('scroll', onLayout, true);
    target.addEventListener('scroll', onScroll, true);
  };

  const getRectForIndex = (index: number): DOMRect | null => {
    for (let i = 0; i < spanNodes.length; i++) {
      const s = spanNodes[i];
      if (index >= s.start && index < s.end) {
        try { return s.node.getBoundingClientRect(); } catch {}
      }
    }
    return null;
  };

  const getRectForRange = (start: number, end: number): DOMRect | null => {
    // Use the first span intersecting the range
    for (let i = 0; i < spanNodes.length; i++) {
      const s = spanNodes[i];
      if (end > s.start && start < s.end) {
        try { return s.node.getBoundingClientRect(); } catch {}
      }
    }
    return null;
  };

  return { element: overlay, content, attach, unmount, render, applyComputedStyles, syncScroll, getRectForIndex, getRectForRange };
}

function replaceSelection(el: HTMLElement, replacement: string) {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const before = el.value.slice(0, start);
    const after = el.value.slice(end);
    const newVal = before + replacement + after;
    el.value = newVal;
    const newCursor = before.length + replacement.length;
    el.setSelectionRange(newCursor, newCursor);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (el.isContentEditable) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(replacement));
      range.collapse(false);
      // Fire input event for frameworks/listeners
      try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
    }
  }
}

function getSelectionText(el: HTMLElement): string {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    return el.value.substring(start, end);
  } else if (el.isContentEditable) {
    const sel = window.getSelection();
    return sel?.toString() ?? '';
  }
  return '';
}

function replaceWhole(el: HTMLElement, text: string, emitInput: boolean = true) {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    el.value = text;
    const pos = el.value.length;
    el.setSelectionRange(pos, pos);
    if (emitInput) el.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (el.isContentEditable) {
    el.textContent = text;
    // Notify listeners so realtime proofread refreshes immediately
    try { if (emitInput) el.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
  }
}

// UI Components
function Popover({ target, onDisable }: { target: HTMLElement | null; onDisable: () => void }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'proofread' | 'rewrite' | 'write'>('proofread');
  const [error, setError] = useState<string | null>(null);
  // Independent tab states
  const [pLoading, setPLoading] = useState(false);
  const [pResult, setPResult] = useState('');

  const [rwLoading, setRwLoading] = useState(false);
  const [rwTone, setRwTone] = useState<'more-casual' | 'as-is' | 'more-formal'>('as-is');
  const [rwLength, setRwLength] = useState<'shorter' | 'as-is' | 'longer'>('as-is');
  const [rwResult, setRwResult] = useState('');

  const [wLoading, setWLoading] = useState(false);
  const [wPrompt, setWPrompt] = useState('');
  const [wTone, setWTone] = useState<'formal' | 'neutral' | 'casual'>('neutral');
  const [wLength, setWLength] = useState<'short' | 'medium' | 'long'>('medium');
  const [wResult, setWResult] = useState('');

  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [panelPos, setPanelPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [panelMaxH, setPanelMaxH] = useState<number>(Math.round(window.innerHeight * 0.7));
  const [panelW, setPanelW] = useState<number>(Math.max(240, Math.min(320, window.innerWidth - 16)));
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [userMoved, setUserMoved] = useState(false);
  const dragRef = useRef<null | { offsetX: number; offsetY: number }>(null);
  const lastSelRef = useRef<
    | { kind: 'input'; start: number; end: number }
    | { kind: 'ce'; range: Range }
    | null
  >(null);
  const lastProofreadTextRef = useRef<string>('');

  const captureSelection = () => {
    if (!target) return;
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? start;
      lastSelRef.current = { kind: 'input', start, end };
    } else if (target.isContentEditable) {
      const sel = document.getSelection();
      if (sel && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0);
        if (r && target.contains(r.startContainer)) {
          lastSelRef.current = { kind: 'ce', range: r.cloneRange() };
        }
      }
    }
  };

  // Position the GX bubble near the active target and keep it clamped in viewport
  const updatePosition = () => {
    const bubble = BUBBLE;
    const margin = MARGIN;
    if (!target) {
      // Fallback/pinned placement when no detectable editable (e.g., Google Docs)
      const top = clamp(window.innerHeight - bubble - margin, margin, window.innerHeight - bubble - margin);
      const left = clamp(window.innerWidth - bubble - margin, margin, window.innerWidth - bubble - margin);
      setPosition({ top, left });
      return;
    }
    const rect = target.getBoundingClientRect();
    // Fall back to pinned placement if rect is degenerate (seen in Gmail)
    if (!isFinite(rect.top) || !isFinite(rect.left) || rect.width < 4 || rect.height < 4) {
      const top = clamp(window.innerHeight - bubble - margin, margin, window.innerHeight - bubble - margin);
      const left = clamp(window.innerWidth - bubble - margin, margin, window.innerWidth - bubble - margin);
      setPosition({ top, left });
      return;
    }
    let top = rect.bottom - bubble / 2;
    let left = rect.right - bubble / 2;
    top = clamp(top, margin, window.innerHeight - bubble - margin);
    left = clamp(left, margin, window.innerWidth - bubble - margin);
    setPosition({ top, left });
  };

  useEffect(() => {
    updatePosition();
    const onScroll = () => updatePosition();
    const onResize = () => updatePosition();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  // Keep panel beside the textarea and inside the viewport in a simple, reusable way
  useEffect(() => {
    if (!open) return;
    if (target) {
      updatePopupPlacement(true);
      const onReflow = () => updatePopupPlacement(false);
      window.addEventListener('resize', onReflow);
      window.addEventListener('scroll', onReflow, true);
      return () => {
        window.removeEventListener('resize', onReflow);
        window.removeEventListener('scroll', onReflow, true);
      };
    } else {
      // Default placement when no target (e.g., Docs): bottom-right with margins
      const margin = MARGIN;
      const w = Math.min(Math.max(PANEL_MIN_W, 300), Math.min(PANEL_MAX_W, window.innerWidth - margin * 2));
      setPanelW(w);
      const top = clamp(window.innerHeight - 260 - margin, margin, window.innerHeight - 260 - margin);
      const left = clamp(window.innerWidth - w - margin, margin, window.innerWidth - w - margin);
      setPanelPos({ top, left });
      setPanelMaxH(Math.max(160, Math.round(window.innerHeight * PANEL_MAX_VH)));
      const onReflow = () => {
        const ww = Math.min(Math.max(PANEL_MIN_W, w), Math.min(PANEL_MAX_W, window.innerWidth - margin * 2));
        setPanelW(ww);
        const t = clamp(window.innerHeight - 260 - margin, margin, window.innerHeight - 260 - margin);
        const l = clamp(window.innerWidth - ww - margin, margin, window.innerWidth - ww - margin);
        setPanelPos({ top: t, left: l });
        setPanelMaxH(Math.max(160, Math.round(window.innerHeight * PANEL_MAX_VH)));
      };
      window.addEventListener('resize', onReflow);
      window.addEventListener('scroll', onReflow, true);
      return () => {
        window.removeEventListener('resize', onReflow);
        window.removeEventListener('scroll', onReflow, true);
      };
    }
  }, [open, target]);

  // Close when clicking outside panel or button
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (panelRef.current && t && panelRef.current.contains(t)) return;
      if (btnRef.current && t && btnRef.current.contains(t)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  // Broadcast panel open/close so App can keep target while interacting with UI
  useEffect(() => {
    try { document.dispatchEvent(new CustomEvent(open ? 'gx:panel-open' : 'gx:panel-close')); } catch {}
  }, [open]);

  // Load models lazily based on panel/tab usage
  useEffect(() => {
    if (!open) {
      // When panel closes, drop Writer/Rewriter but keep Proofreader to support realtime
      try { callInpage('disposeNonProofreader', {}); } catch {}
      return;
    }
    // On open, ensure proofreader is ready so first interaction is fast
    try { callInpage('ensure', { model: 'proofreader' }); } catch {}
  }, [open]);

  // Preload model for the active tab so it downloads in the background
  useEffect(() => {
    if (!open) return;
    if (tab === 'write') {
      try { callInpage('ensure', { model: 'writer' }); } catch {}
    } else if (tab === 'rewrite') {
      try { callInpage('ensure', { model: 'rewriter' }); } catch {}
    } else if (tab === 'proofread') {
      try { callInpage('ensure', { model: 'proofreader' }); } catch {}
    }
  }, [open, tab]);

  // Auto-run proofread when opening the panel on Proofread tab or when switching to it
  useEffect(() => {
    if (!open || tab !== 'proofread' || !target || pLoading) return;
    const text = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target.value : target.innerText;
    if (text === lastProofreadTextRef.current) return;
    lastProofreadTextRef.current = text;
    runProofread();
    // runProofread will reposition panel in its finally
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab, target]);

  const runProofread = async () => {
    if (!target) return;
    setPLoading(true); setError(null); setPResult('');
    try {
      const text = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target.value : target.innerText;
      /* console.log('[Typerra][CS] Proofread start', {
        targetTag: (target as HTMLElement).tagName,
        isCE: (target as HTMLElement).isContentEditable,
        textLen: text?.length ?? 0,
        preview: (text || '').slice(0, 64)
      }); */
      const response = await callInpage<{ corrected: string; corrections: any[] }>('proofread', { text });
      /* console.log('[Typerra][CS] Proofread success', {
        correctedLen: response?.corrected?.length ?? 0,
        correctionsCount: Array.isArray(response?.corrections) ? response.corrections.length : 'n/a'
      }); */
      setPResult(response.corrected);
    } catch (e: any) {
  // console.error('[Typerra][CS] Proofread error', e);
      setError(e.message || String(e));
    } finally {
      setPLoading(false);
      // Reposition panel after result renders
      try { (updatePopupPlacement as any)?.(true); } catch {}
    }
  };

  const applyProofread = () => {
    if (!target || !pResult) return;
    // Replace without emitting input to avoid immediate re-run
    replaceWhole(target, pResult, false);
    // Clear overlays/suggestions until user types again
    try { document.dispatchEvent(new CustomEvent('gx:clear')); } catch {}
    // Reposition GX bubble to stay aligned
    updatePosition();
  };

  // Simple, reusable placement function to keep panel beside target and within viewport
  const updatePopupPlacement = (measureAfterFrame = true, force = false) => {
    if (!open || !target) return;
    if (userMoved && !force) return; // don't override user's manual position
    const margin = MARGIN;
    const allowedMaxW = Math.min(PANEL_MAX_W, window.innerWidth - margin * 2);
    // Prefer at least the target width for better readability
    const initialW = Math.max(PANEL_MIN_W, Math.min(allowedMaxW, Math.max((target as HTMLElement).getBoundingClientRect().width, 280)));
    const panelWidth = initialW;
    setPanelW(panelWidth);
    const rect = target.getBoundingClientRect();

    const recompute = (measuredH?: number) => {
  const estH = measuredH ?? 320;
      const spaceBelow = window.innerHeight - rect.bottom - margin;
      const spaceAbove = rect.top - margin;
  const placeBelow = spaceBelow >= Math.min(estH, window.innerHeight * PANEL_MAX_VH) || spaceBelow >= spaceAbove;

      // Vertical placement
      let top = placeBelow ? rect.bottom + margin : rect.top - estH - margin;
      // Horizontal placement: align to target's left, clamp to viewport
      let left = rect.left;

      // Clamp horizontally
      if (left + panelWidth + margin > window.innerWidth) left = window.innerWidth - panelWidth - margin;
      if (left < margin) left = margin;

      // Compute max height to avoid spilling outside viewport
      const availableV = placeBelow ? spaceBelow : spaceAbove;
  const maxH = Math.max(160, Math.min(Math.round(window.innerHeight * PANEL_MAX_VH), Math.floor(availableV)));

      // Clamp vertical using estimated/measured height
  top = clamp(top, margin, window.innerHeight - estH - margin);

      setPanelMaxH(maxH);
      setPanelPos({ top, left });

      // If content is too tall and we have horizontal room, grow width to reduce height
      if (measuredH && measuredH >= maxH - 8 && panelW < allowedMaxW) {
        const growBy = Math.min(allowedMaxW - panelW, 140);
        const newW = panelW + growBy;
        setPanelW(newW);
        // Re-clamp left for new width
        let newLeft = rect.left;
        if (newLeft + newW + margin > window.innerWidth) newLeft = window.innerWidth - newW - margin;
        if (newLeft < margin) newLeft = margin;
        setPanelPos({ top, left: newLeft });
      }
    };

    // First pass with estimated height
    recompute();

    if (measureAfterFrame) {
      requestAnimationFrame(() => {
        if (panelRef.current) {
          const h1 = panelRef.current.getBoundingClientRect().height;
          recompute(h1);
          // Measure again after potential width growth
          requestAnimationFrame(() => {
            if (panelRef.current) {
              const h2 = panelRef.current.getBoundingClientRect().height;
              recompute(h2);
            }
          });
        }
      });
    }
  };

  // Drag to move: handle mousedown on drag handle
  const onDragStart = (e: React.MouseEvent) => {
    if (!panelRef.current) return;
    e.preventDefault();
    const rect = panelRef.current.getBoundingClientRect();
    dragRef.current = { offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const w = panelRef.current?.getBoundingClientRect().width ?? panelW;
      const h = panelRef.current?.getBoundingClientRect().height ?? 200;
      let left = ev.clientX - dragRef.current.offsetX;
      let top = ev.clientY - dragRef.current.offsetY;
      left = clamp(left, MARGIN, window.innerWidth - w - MARGIN);
      top = clamp(top, MARGIN, window.innerHeight - h - MARGIN);
      setPanelPos({ top, left });
    };
    const onUp = () => {
      dragRef.current = null;
      setUserMoved(true);
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      // restore selection
      try { (document.body.style as any).userSelect = ''; } catch {}
    };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
    // prevent text selection while dragging
    try { (document.body.style as any).userSelect = 'none'; } catch {}
  };

  const runRewrite = async () => {
    if (!target) return;
    setRwLoading(true); setError(null); setRwResult('');
    try {
      const base = getSelectionText(target) || (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target.value : target.innerText);
      const response = await callInpage<string>('rewrite', { text: base, tone: rwTone, length: rwLength });
      setRwResult(response);
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setRwLoading(false);
      updatePopupPlacement(true);
    }
  };

  const applyRewrite = () => {
    if (!target || !rwResult) return;
    const selected = getSelectionText(target);
    if (selected) replaceSelection(target, rwResult); else replaceWhole(target, rwResult);
  };

  const runWrite = async () => {
    setWLoading(true); setError(null); setWResult('');
    try {
      const response = await callInpage<string>('write', { prompt: wPrompt, tone: wTone, length: wLength });
      setWResult(response);
    } catch (e: any) { setError(e.message || String(e)); }
    finally { setWLoading(false); updatePopupPlacement(true); }
  };

  const applyWrite = () => {
    if (!target || !wResult) return;
    const saved = lastSelRef.current;
    if (saved) {
      if (saved.kind === 'input' && (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)) {
        const start = Math.max(0, Math.min(saved.start, target.value.length));
        const end = Math.max(0, Math.min(saved.end, target.value.length));
        const before = target.value.slice(0, start);
        const after = target.value.slice(end);
        target.value = before + wResult + after;
        const caret = before.length + wResult.length;
        target.setSelectionRange(caret, caret);
        target.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      if (saved.kind === 'ce' && target.isContentEditable) {
        try {
          target.focus();
          const sel = document.getSelection();
          sel?.removeAllRanges();
          if (saved.range) sel?.addRange(saved.range);
          const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
          if (range) {
            range.deleteContents();
            range.insertNode(document.createTextNode(wResult));
            range.collapse(false);
            return;
          }
        } catch {}
      }
    }
    // Fallback
    replaceSelection(target, wResult);
  };

  return (
    <div style={{ position: 'absolute', top: position.top, left: position.left, zIndex: 2147483647 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button
            ref={btnRef}
            onMouseDown={() => captureSelection()}
            onClick={() => setOpen((o) => { const n = !o; if (n) setUserMoved(false); return n; })}
            title="Typerra"
            style={buttonStyle}
          >
            TP
            <span
              title="Disable Typerra"
              style={killIconStyle}
              onMouseDown={(e)=> { e.preventDefault(); e.stopPropagation(); }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                try { document.dispatchEvent(new CustomEvent('gx:clear')); } catch {}
                // Proactively dispose models in this page to free RAM
                try { callInpage('dispose', {}); } catch {}
                onDisable();
                setOpen(false);
              }}
            >
              ×
            </span>
          </button>
        </div>
        {open && (
          <div ref={panelRef} style={{ ...panelStyle, position: 'fixed', top: panelPos.top, left: panelPos.left, maxHeight: panelMaxH, overflow: 'auto', width: panelW, maxWidth: 'calc(100vw - 16px)' }}>
            <div style={dragBarStyle} onMouseDown={onDragStart} title="Drag to move">⠿</div>
            <div style={tabsStyle}>
              <button style={tab === 'proofread' ? tabActiveStyle : tabStyle} onClick={() => setTab('proofread')}>Proofread</button>
              <button style={tab === 'rewrite' ? tabActiveStyle : tabStyle} onClick={() => setTab('rewrite')}>Rewrite</button>
              <button style={tab === 'write' ? tabActiveStyle : tabStyle} onClick={() => setTab('write')}>Write</button>
            </div>
            {tab === 'proofread' && (
              <div style={sectionStyle}>
                {pLoading && <div style={mutedStyle}>Checking…</div>}
                {!pLoading && pResult && <>
                  <textarea style={textareaStyle} rows={4} value={pResult} onChange={(e)=>setPResult(e.target.value)} />
                  <button onClick={applyProofread} style={secondaryBtn}>Apply</button>
                </>}
              </div>
            )}
            {tab === 'rewrite' && (
              <div style={sectionStyle}>
                <div style={rowStyle}>
                  <label style={labelStyle}> Tone: </label>
                  <select style={selectStyle} value={rwTone} onChange={(e)=>setRwTone(e.target.value as any)}>
                    <option value="more-formal">More formal</option>
                    <option value="as-is">As-is</option>
                    <option value="more-casual">More casual</option>
                  </select>
                  <label style={labelStyle}> Length: </label>
                  <select style={selectStyle} value={rwLength} onChange={(e)=>setRwLength(e.target.value as any)}>
                    <option value="shorter">Shorter</option>
                    <option value="as-is">As-is</option>
                    <option value="longer">Longer</option>
                  </select>
                </div>
                <button disabled={rwLoading} onClick={runRewrite} style={primaryBtn}>Rewrite selection or field</button>
                {rwResult && <>
                  <textarea style={textareaStyle} rows={4} value={rwResult} onChange={(e)=>setRwResult(e.target.value)} />
                  <button onClick={applyRewrite} style={secondaryBtn}>Replace</button>
                </>}
              </div>
            )}
            {tab === 'write' && (
              <div style={sectionStyle}>
                <textarea placeholder="Describe what to write…" style={textareaStyle} rows={3} value={wPrompt} onChange={(e)=>setWPrompt(e.target.value)} />
                <div style={rowStyle}>
                  <label style={labelStyle}> Tone: </label>
                  <select style={selectStyle} value={wTone} onChange={(e)=>setWTone(e.target.value as any)}>
                    <option value="formal">Formal</option>
                    <option value="neutral">Neutral</option>
                    <option value="casual">Casual</option>
                  </select>
                  <label style={labelStyle}> Length: </label>
                  <select style={selectStyle} value={wLength} onChange={(e)=>setWLength(e.target.value as any)}>
                    <option value="short">Short</option>
                    <option value="medium">Medium</option>
                    <option value="long">Long</option>
                  </select>
                </div>
                <button disabled={wLoading || !wPrompt} onClick={runWrite} style={primaryBtn}>Generate</button>
                {wResult && <>
                  <textarea style={textareaStyle} rows={6} value={wResult} onChange={(e)=>setWResult(e.target.value)} />
                  <button onClick={applyWrite} style={secondaryBtn}>Insert</button>
                </>}
              </div>
            )}
            {error && <div style={errorStyle}>{error}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  position: 'relative',
  background: '#2563eb', color: '#fff', border: 'none', borderRadius: 14, width: 24, height: 24,
  fontWeight: 700, fontSize: SMALL_FONT, cursor: 'pointer', boxShadow: '0 2px 10px rgba(37,99,235,0.3)'
};
const killIconStyle: React.CSSProperties = {
  position: 'absolute',
  top: -5, right: -5,
  background: '#e5e7eb', color: '#0f172a', border: '1px solid #cbd5e1', borderRadius: 10,
  width: 12, height: 12, lineHeight: '10px', textAlign: 'center', cursor: 'pointer',
  fontWeight: 700 as any, fontSize: 8, boxShadow: '0 1px 6px rgba(0,0,0,0.08)'
};
const panelStyle: React.CSSProperties = {
  width: 300, background: '#ffffff', color: '#0f172a', borderRadius: 12, padding: 10,
  boxShadow: '0 10px 30px rgba(0,0,0,0.12)', border: '1px solid #e5e7eb',
  boxSizing: 'border-box', fontFamily: '-apple-system, system-ui, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
  fontSize: BASE_FONT
};
const tabsStyle: React.CSSProperties = { display: 'flex', gap: 6, marginBottom: 8 };
const tabStyle: React.CSSProperties = { flex: 1, padding: '4px 8px', background: '#f1f5f9', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: SMALL_FONT };
const tabActiveStyle: React.CSSProperties = { ...tabStyle, background: '#dbeafe', fontWeight: 600 };
const sectionStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 };
const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: SMALL_FONT };
const textareaStyle: React.CSSProperties = { width: '100%', borderRadius: 8, border: '1px solid #e5e7eb', padding: 8, boxSizing: 'border-box', fontSize: SMALL_FONT, lineHeight: 1.4 };
const primaryBtn: React.CSSProperties = { padding: '6px 10px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: SMALL_FONT } as any;
const secondaryBtn: React.CSSProperties = { padding: '6px 10px', background: '#f3f4f6', color: '#0f172a', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontSize: SMALL_FONT } as any;
const errorStyle: React.CSSProperties = { color: '#b91c1c', fontSize: SMALL_FONT };
const mutedStyle: React.CSSProperties = { color: '#64748b', fontSize: SMALL_FONT };
const dragBarStyle: React.CSSProperties = {
  cursor: 'move',
  width: '100%',
  height: 12,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#94a3b8',
  userSelect: 'none',
  marginTop: -4,
  marginBottom: 4,
};
const labelStyle: React.CSSProperties = { color: '#64748b', fontSize: SMALL_FONT };
const selectStyle: React.CSSProperties = {
  appearance: 'none',
  WebkitAppearance: 'none' as any,
  MozAppearance: 'none' as any,
  backgroundColor: '#ffffff',
  border: '1px solid #e5e7eb',
  borderRadius: 8,
  padding: '4px 8px',
  paddingRight: 24,
  fontSize: SMALL_FONT,
  color: '#0f172a',
  outline: 'none',
  lineHeight: 1.2,
  boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.02)'
};

function App() {
  const [enabled, setEnabled] = useState<boolean>(true);
  const [realtimeEnabled, setRealtimeEnabled] = useState<boolean>(true);
  const [target, setTarget] = useState<HTMLElement | null>(getActiveEditable());
  const panelOpenRef = useRef<boolean>(false);
  const overlayRef = useRef<ReturnType<typeof createUnderlineOverlay> | null>(null);
  const debounceRef = useRef<number | null>(null);
  const inflightRef = useRef<number>(0);
  const lastTextRef = useRef<string>('');
  const lastRangesRef = useRef<ProofreadRange[]>([]);
  const lastProofreadAtRef = useRef<number>(0);
  const [suggest, setSuggest] = useState<{ open: boolean; top: number; left: number; text: string; range: { start: number; end: number } | null }>({ open: false, top: 0, left: 0, text: '', range: null });
  const CLIENT_IDLE_DISPOSE_MS = 30_000; // if UI is inactive and no target for 30s, dispose models in this page

  // Per-tab only: start enabled by default; disabling via × affects only this tab instance
  useEffect(() => {
    setEnabled(true);
  }, []);

  // Proactive page-level idle disposal: if there's no active target, no overlay, and no UI open
  // for a while, dispose models in this page context to minimize RAM footprint.
  useEffect(() => {
    const t = window.setInterval(() => {
      try {
        const now = Date.now();
        const noTarget = !target;
        const noUI = !panelOpenRef.current && !suggest.open;
        const noOverlay = !overlayRef.current;
        const longSinceProofread = now - (lastProofreadAtRef.current || 0) > CLIENT_IDLE_DISPOSE_MS;
        if (noTarget && noUI && noOverlay && longSinceProofread) {
          if (document.getElementById('typerra-inpage')) {
            // Best-effort; do not inject inpage if not present
            callInpage('dispose', {} as any).catch(()=>{});
          }
        }
      } catch {}
    }, 10_000);
    return () => { try { window.clearInterval(t); } catch {} };
  }, [target, suggest.open]);

  // Global realtime proofread toggle via storage (affects all tabs)
  useEffect(() => {
    try {
      chrome.storage.sync.get(['realtimeProofread'], (res) => {
        if (typeof res.realtimeProofread === 'boolean') setRealtimeEnabled(res.realtimeProofread);
      });
    } catch {}
    const onStorage = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area === 'sync' && changes.realtimeProofread) {
        const next = !!changes.realtimeProofread.newValue;
        setRealtimeEnabled(next);
        // If realtime is turned off, free all models in this page without injecting inpage if it's not present
        if (!next) {
          try {
            if (document.getElementById('typerra-inpage')) {
              callInpage('dispose', {});
            }
          } catch {}
        }
      }
    };
    try { chrome.storage.onChanged.addListener(onStorage); } catch {}
    return () => {
      try { chrome.storage.onChanged.removeListener(onStorage); } catch {}
    };
  }, []);

  useEffect(() => {
  const root = document.getElementById('typerra-root');

    const onFocusIn = (e: Event) => {
      const t = e.target as Node | null;
      // If focus is inside our own UI, keep current target so GX stays for click/panel
      if (root && t && root.contains(t)) return;
      const editable = getActiveEditable();
      if (!editable && panelOpenRef.current) return; // keep while panel is open
      setTarget(editable ?? null);
    };

    const onSelectionChange = () => {
      const sel = document.getSelection();
      const anchor = sel?.anchorNode || null;
      // If selection is inside our UI, keep current target
      if (root && anchor && root.contains(anchor)) return;
      const editable = getActiveEditable();
      if (!editable && panelOpenRef.current) return;
      setTarget(editable ?? null);
    };

    const onFocusOut = () => {
      // After focus moves, determine if an editable is focused; otherwise hide GX
      setTimeout(() => {
        const ae = document.activeElement as HTMLElement | null;
        if (root && ae && root.contains(ae)) return; // interacting with our UI; keep GX
        const editable = getActiveEditable();
        if (!editable && panelOpenRef.current) return;
        setTarget(editable ?? null);
      }, 0);
    };

    // Use capture to improve focus tracking across shadow roots
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('selectionchange', onSelectionChange);
    // Track panel open/close
    const onPanelOpen = () => { panelOpenRef.current = true; };
    const onPanelClose = () => { panelOpenRef.current = false; };
    document.addEventListener('gx:panel-open' as any, onPanelOpen as any);
    document.addEventListener('gx:panel-close' as any, onPanelClose as any);
    return () => {
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('gx:panel-open' as any, onPanelOpen as any);
      document.removeEventListener('gx:panel-close' as any, onPanelClose as any);
    };
  }, []);

  // Real-time proofread underline: run after pauses or word boundaries and draw red waves
  useEffect(() => {
    if (!enabled || !realtimeEnabled || !target || !isEditable(target)) {
      // cleanup previous overlay if any
      if (overlayRef.current) { overlayRef.current.unmount(); overlayRef.current = null; }
      return;
    }

    // Create/attach overlay for current target
    const overlay = createUnderlineOverlay(target);
    overlay.attach();
    overlayRef.current = overlay;

    const schedule = (immediate = false) => {
      if (debounceRef.current) { window.clearTimeout(debounceRef.current); debounceRef.current = null; }
      const delay = immediate ? 0 : 350;
      debounceRef.current = window.setTimeout(async () => {
        const text = getEditableText(target);
        // Skip realtime for very large fields to avoid memory/CPU spikes
        if (text.length > MAX_REALTIME_CHARS) {
          if (overlayRef.current) { overlayRef.current.unmount(); overlayRef.current = null; }
          return;
        }
        // Throttle requests
        const now = Date.now();
        const elapsed = now - (lastProofreadAtRef.current || 0);
        if (elapsed < MIN_INTERVAL_MS && !immediate) {
          // reschedule to the next window
          debounceRef.current = window.setTimeout(() => schedule(true), MIN_INTERVAL_MS - elapsed) as any;
          return;
        }
        const token = ++inflightRef.current;
        try {
          const res = await callInpage<ProofreadPayload>('proofread', { text }).catch((e)=>{
            const msg = String(e?.message || e || '').toLowerCase();
            // Swallow benign cancellations
            if (msg.includes('cancel')) return { corrected: text, corrections: [], ranges: [], cancelled: true } as ProofreadPayload;
            throw e;
          });
          if (token !== inflightRef.current) return; // canceled by newer request
          if (res?.cancelled) return; // benign cancel
          const ranges = Array.isArray(res?.ranges) ? res.ranges! : [];
          lastTextRef.current = text;
          lastRangesRef.current = ranges;
          lastProofreadAtRef.current = Date.now();
          overlay.render(text, ranges);
          overlay.applyComputedStyles();
          overlay.syncScroll();
          // After render, update suggestion for current caret
          setTimeout(() => {
            try { updateSuggestionForCaret(); } catch {}
          }, 0);
        } catch (e) {
          // swallow
        }
      }, delay) as any;
    };

    const onInput = (e: Event) => {
      const el = e.target as HTMLElement | null;
      if (!el || el !== target) return;
      const value = getEditableText(target);
      const last = value.slice(-1);
      const boundary = /\s|[\.,!?;:]/.test(last);
      schedule(boundary);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') schedule(true);
    };

  // initial
  schedule(true);

    target.addEventListener('input', onInput);
    target.addEventListener('keyup', onKeyUp);
    // layout updates
    const onLayout = () => { overlay.applyComputedStyles(); overlay.syncScroll(); };
    window.addEventListener('scroll', onLayout, true);
    window.addEventListener('resize', onLayout, true);

    return () => {
      if (debounceRef.current) { window.clearTimeout(debounceRef.current); debounceRef.current = null; }
      inflightRef.current++;
      target.removeEventListener('input', onInput);
      target.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('scroll', onLayout, true);
      window.removeEventListener('resize', onLayout, true);
      overlay.unmount();
      if (overlayRef.current === overlay) overlayRef.current = null;
      setSuggest((s) => ({ ...s, open: false }));
    };
  }, [enabled, realtimeEnabled, target]);

  // Utilities to compute caret offset within editable
  function getCaretIndexInEditable(root: HTMLElement): number | null {
    if (root instanceof HTMLInputElement || root instanceof HTMLTextAreaElement) {
      const i = root.selectionStart;
      return typeof i === 'number' ? i : null;
    }
    if (!root.isContentEditable) return null;
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    // ensure range is within root
    if (!root.contains(range.startContainer)) return null;
    let index = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let node: Node | null = walker.nextNode();
    while (node) {
      const text = (node.nodeValue || '');
      if (node === range.startContainer) {
        index += range.startOffset;
        return index;
      }
      index += text.length;
      node = walker.nextNode();
    }
    return index;
  }

  function updateSuggestionForCaret() {
    if (!target || !overlayRef.current) return;
    const text = getEditableText(target);
    if (text !== lastTextRef.current) return; // wait for proofread sync
    const idx = getCaretIndexInEditable(target);
    if (idx == null) { if (suggest.open) setSuggest((s)=>({ ...s, open: false })); return; }
    const ranges = lastRangesRef.current || [];
    const r = ranges.find((rr) => idx >= rr.start && idx < rr.end);
    if (!r || !r.replacement) { if (suggest.open) setSuggest((s)=>({ ...s, open: false })); return; }
    const rect = overlayRef.current.getRectForRange(r.start, r.end) || overlayRef.current.getRectForIndex(idx);
    if (!rect) { if (suggest.open) setSuggest((s)=>({ ...s, open: false })); return; }
    const margin = 6;
    const bubbleTop = rect.top - 28 - margin; // above word
    const bubbleLeft = clamp(rect.left, 8, window.innerWidth - 160 - 8);
    setSuggest({ open: true, top: bubbleTop, left: bubbleLeft, text: r.replacement!, range: { start: r.start, end: r.end } });
  }

  async function proofreadNow() {
    if (!target || !overlayRef.current) return;
    const text = getEditableText(target);
    try {
      const res = await callInpage<ProofreadPayload>('proofread', { text });
      const ranges = Array.isArray(res?.ranges) ? res.ranges! : [];
      lastTextRef.current = text;
      lastRangesRef.current = ranges;
      overlayRef.current.render(text, ranges);
      overlayRef.current.applyComputedStyles();
      overlayRef.current.syncScroll();
      updateSuggestionForCaret();
    } catch {}
  }

  useEffect(() => {
    if (!enabled || !realtimeEnabled) return;
    const onSel = () => { try { updateSuggestionForCaret(); } catch {} };
    document.addEventListener('selectionchange', onSel);
    window.addEventListener('resize', onSel, true);
    window.addEventListener('scroll', onSel, true);
    return () => {
      document.removeEventListener('selectionchange', onSel);
      window.removeEventListener('resize', onSel, true);
      window.removeEventListener('scroll', onSel, true);
    };
  }, [enabled, realtimeEnabled, target]);

  // Hide single-word suggestion bubble when focus leaves the target or moves outside text
  useEffect(() => {
    if (!enabled || !realtimeEnabled) return;
  const root = document.getElementById('typerra-root');
    const onFocusEdge = (e: Event) => {
      const t = e.target as Node | null;
      // Ignore focus changes within our own UI
      if (root && t && root.contains(t)) return;
      const ae = document.activeElement as HTMLElement | null;
      if (!ae || ae !== target) {
        if (suggest.open) setSuggest((s) => ({ ...s, open: false }));
      }
    };
    document.addEventListener('focusin', onFocusEdge, true);
    document.addEventListener('focusout', onFocusEdge, true);
    return () => {
      document.removeEventListener('focusin', onFocusEdge, true);
      document.removeEventListener('focusout', onFocusEdge, true);
    };
  }, [enabled, realtimeEnabled, target, suggest.open]);

  // Clear overlays/suggestions on demand (e.g., after full Apply or when disabling)
  useEffect(() => {
    const onClear = () => {
      try {
        if (overlayRef.current) {
          overlayRef.current.unmount();
          overlayRef.current = null;
        }
      } catch {}
      setSuggest((s) => ({ ...s, open: false }));
    };
    // Using any to avoid TS narrow event type for custom name
    document.addEventListener('gx:clear' as any, onClear as any);
    return () => { document.removeEventListener('gx:clear' as any, onClear as any); };
  }, []);

  // Replace the range with suggestion text
  function applySuggestion() {
    if (!target || !suggest.open || !suggest.range) return;
    const { start, end } = suggest.range;
    const replacement = suggest.text;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const s = clamp(start, 0, target.value.length);
      const e = clamp(end, s, target.value.length);
      target.setSelectionRange(s, e);
      replaceSelection(target, replacement);
      setSuggest((s0)=>({ ...s0, open: false }));
      // Immediately refresh proofread so other mistakes persist and indices stay in sync
      setTimeout(() => { proofreadNow(); }, 0);
      return;
    }
    if (target.isContentEditable) {
      // Map offsets to a DOM Range within target and replace
      const setRangeByOffsets = (root: HTMLElement, sOff: number, eOff: number): Range | null => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        let node: Node | null = walker.nextNode();
        let acc = 0;
        let sNode: Node | null = null, eNode: Node | null = null;
        let sIn = 0, eIn = 0;
        while (node) {
          const len = (node.nodeValue || '').length;
          if (sNode == null && acc + len >= sOff) { sNode = node; sIn = sOff - acc; }
          if (eNode == null && acc + len >= eOff) { eNode = node; eIn = eOff - acc; break; }
          acc += len;
          node = walker.nextNode();
        }
        if (!sNode) { sNode = root; sIn = 0; }
        if (!eNode) { eNode = sNode; eIn = sIn; }
        try {
          const r = document.createRange();
          r.setStart(sNode, sIn);
          r.setEnd(eNode, eIn);
          return r;
        } catch { return null; }
      };
      const domRange = setRangeByOffsets(target, start, end);
      if (domRange) {
        const sel = document.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(domRange);
        replaceSelection(target, replacement);
        setSuggest((s0)=>({ ...s0, open: false }));
        setTimeout(() => { proofreadNow(); }, 0);
        return;
      }
    }
  }

  if (!enabled) return null;
  return (
    <>
  <Popover target={target} onDisable={() => setEnabled(false)} />
      {suggest.open && (
        <div
          style={{ position: 'fixed', top: suggest.top, left: suggest.left, zIndex: 2147483647, background: '#ffffff', color: '#0f172a', border: '1px solid #e5e7eb', borderRadius: 8, padding: '4px 8px', fontSize: SMALL_FONT, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', cursor: 'pointer', maxWidth: 160, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}
          onMouseDown={(e)=> e.preventDefault()}
          onClick={(e)=> { e.preventDefault(); applySuggestion(); }}
          title="Click to replace"
        >
          {suggest.text}
        </div>
      )}
    </>
  );
}

// Mount React lazily on first focus of an editable (reduces idle per-tab memory)
(function mountReactOnDemand() {
  const rootId = 'typerra-root';
  let mounted = false;
  function mount() {
    if (mounted || document.getElementById(rootId)) return;
    const host = document.createElement('div');
    host.id = rootId;
    host.style.position = 'fixed';
    host.style.top = '0';
    host.style.left = '0';
    host.style.zIndex = '2147483647';
    document.documentElement.appendChild(host);
    const root = createRoot(host);
    root.render(<App />);
    mounted = true;
  }
  if (IS_GOOGLE_DOCS || IS_GMAIL) {
    // On Google Docs and Gmail, mount immediately so the bubble is available even before focus
    try { mount(); } catch {}
  } else {
    const onFocusIn = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (t && isEditable(t)) {
        try { mount(); } catch {}
        document.removeEventListener('focusin', onFocusIn, true);
      }
    };
    document.addEventListener('focusin', onFocusIn, true);
  }
})();
