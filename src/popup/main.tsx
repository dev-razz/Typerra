import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

function Popup() {
  const [realtime, setRealtime] = useState(true);
  const [defaultTone, setDefaultTone] = useState<'neutral'|'casual'|'formal'>('neutral');

  useEffect(() => {
    const load = () => {
      try {
        chrome.storage.sync.get(['realtimeProofread', 'defaultTone'], (res) => {
          if (typeof res?.realtimeProofread === 'boolean') setRealtime(res.realtimeProofread);
          if (res?.defaultTone) setDefaultTone(res.defaultTone);
        });
      } catch {}
    };
    // Defer storage read until after first paint to keep popup snappy
    if (typeof (window as any).requestIdleCallback === 'function') {
      (window as any).requestIdleCallback(load, { timeout: 250 });
    } else {
      setTimeout(load, 0);
    }
  }, []);

  const save = () => {
    chrome.storage.sync.set({ realtimeProofread: realtime, defaultTone });
  };

  return (
    <div style={{ padding: 12, width: 300, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif' }}>
  <h3>Typerra</h3>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" checked={realtime} onChange={(e)=>setRealtime(e.target.checked)} /> Realtime proofread
      </label>
      <div style={{ marginTop: 12 }}>
        <label>Default writer tone: </label>
        <select value={defaultTone} onChange={(e)=>setDefaultTone(e.target.value as any)}>
          <option value="formal">Formal</option>
          <option value="neutral">Neutral</option>
          <option value="casual">Casual</option>
        </select>
      </div>
      <button onClick={save} style={{ marginTop: 12 }}>Save</button>
      <p style={{ fontSize: 12, color: '#555' }}>To use Writer/Rewriter/Proofreader, make sure you enrolled in the origin trials and added tokens to manifest.json.</p>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Popup />);
