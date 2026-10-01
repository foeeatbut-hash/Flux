import { useEffect } from 'react';
import { useStore } from '../../store/store';
import { rendererEvents } from '../../lib/diagnostics';
import { groupIncidents } from '../../../diagnostics/incidents';

/** Никаких документов и снимков: отправляются только безопасные технические события. */
export default function AutomaticIncidentWatcher() {
  const userId = useStore(s => s.user?.id);
  useEffect(() => {
    if (!userId) return;
    let pending = false; let stopped = false;
    const collect = async () => {
      if (pending || stopped) return; pending = true;
      try {
        const events = rendererEvents().filter(e => !String(e.data.route || '').includes('automatic-incidents'));
        try {
          const part = await (window as any).electron?.diagnostics?.read({ from: Date.now() - 15 * 60000, to: Date.now(), maxBytes: 500000 });
          for (const line of String(part?.text || '').split('\n')) { try { if (line) events.push(JSON.parse(line)); } catch { /* оборванная строка */ } }
        } catch { /* браузер без оболочки */ }
        const candidates = events.filter(e => groupIncidents([e], true).length).slice(-1000);
        if (candidates.length && !stopped) await fetch('/api/feedback/automatic-incidents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events: candidates }) });
      } catch { /* повторный сбор через минуту */ }
      finally { pending = false; }
    };
    const start = setTimeout(() => { void collect(); }, 10000);
    const timer = setInterval(() => { void collect(); }, 60000);
    return () => { stopped = true; clearTimeout(start); clearInterval(timer); };
  }, [userId]);
  return null;
}
