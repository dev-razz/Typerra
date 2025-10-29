# Typerra (React + Vite Chrome Extension)

AI inline assistant for any text field using Chrome's built‑in AI:

- Proofreader API: grammar, spelling, punctuation corrections
- Rewriter API: rewrite text with tones and length adjustments
- Writer API: generate content from a prompt

This is a Manifest V3 extension built with React + Vite.

## Requirements

These built-in AI APIs currently require enabling flags for localhost testing:
- chrome://flags/#proofreader-api-for-gemini-nano
- chrome://flags/#writer-api-for-gemini-nano
- chrome://flags/#rewriter-api-for-gemini-nano

Hardware/OS limits apply (Gemini Nano): desktop Chrome on macOS 13+, Windows 10/11, Linux, or Chromebook Plus. See the official docs for details.

## Setup

1) Install dependencies

```sh
npm install
```

See: https://docs.google.com/document/d/1VG8HIyz361zGduWgNG7R_R8Xkv0OOJ8b5C9QKeCjU0c/edit?tab=t.0

3) Build

```sh
npm run build
```

4) Load in Chrome

- Open chrome://extensions
- Enable Developer mode
- Click "Load unpacked" and select the `dist/` folder

## How it works

- The content script injects a small "TP" button that appears next to the focused text field.
- Clicking the button opens a popover with three tabs: Proofread, Rewrite, Write.
- The in‑page script runs in the page context and calls `Proofreader`, `Writer`, and `Rewriter`. It communicates with the content script via `window.postMessage`.
- Actions:
  - Proofread: runs `proofread()` and shows the corrected text; Apply replaces the whole field.
  - Rewrite: rewrites the selection or entire field (tone/length options); Replace updates selection/field.
  - Write: generates content from a prompt (tone/length options); Insert pastes at the cursor.

## Notes

- For contentEditable, the extension uses a simple selection replace. Complex editors (e.g., Slate/Quill/ProseMirror) may need site‑specific adapters.
- The UI is intentionally minimal. You can style it further or add highlight overlays for per‑correction visualization.
- If availability is `downloadable`, the first call will trigger a model download; downloading can take time.

## Development

- Watch build:

```sh
npm run dev
```
- After rebuilding, click the refresh icon on the extension in chrome://extensions to reload.

## References

- Proofreader API: https://developer.chrome.com/docs/ai/proofreader-api
- Writer API: https://developer.chrome.com/docs/ai/writer-api
- Rewriter API: https://developer.chrome.com/docs/ai/rewriter-api
