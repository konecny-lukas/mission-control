/* MC v2 — sdílené konzolové renderery: Jarvis konzole (ui/jarvis.js) + alert
   thread drawer (ui/thread.js). Vytaženo z ui/jarvis.js BEZE změny chování a
   markup — class-contract .j-msg/.j-tool/.j-q* drží styles.css pro obě konzole.

   makeConsole(log, { onAnswer, scroller }) -> {
     bubble(role, text)        – 'user' | 'bot' (mdFmt) | 'err'
     toolRow(name, input)      – ⏺ Tool(arg…)  (ukončí běžící stream bublinu)
     appendStream(text)        – plynulé přidávání text delt do bot bubliny
     setStreamText(text)       – přepsání obsahu stream bubliny (resync tail)
     resetStream()             – další text začne novou bublinou
     hasStream() / streamText()
     renderQuestion(questions) – AskUserQuestion -> klikací volby -> onAnswer(val)
     scrollDown() / clear()
   }
   readSSE(resp, onFrame)      – parser SSE rámců nad fetch Response;
                                 onFrame(eventName|null, dataStr) jen pro rámce
                                 s data řádkem (': ping' komentáře ignoruje). */

import { el, esc } from '../core/dom.js';

// minimal, XSS-safe markdown: escape first, then **bold** + `code`.
export function mdFmt(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
}

export function toolLabel(name, inp) {
  inp = inp || {}; let arg = '';
  if (name === 'Bash' && inp.command) arg = inp.command;
  else if (inp.file_path) arg = inp.file_path;
  else if (inp.path) arg = inp.path;
  else if (inp.pattern) arg = inp.pattern;
  else if (inp.url) arg = inp.url;
  else { try { arg = JSON.stringify(inp); } catch {} }
  arg = String(arg).replace(/\s+/g, ' ').trim();
  if (arg.length > 70) arg = arg.slice(0, 70) + '…';
  return arg ? `${name}(${arg})` : name;
}

export function makeConsole(log, opts = {}) {
  const onAnswer = opts.onAnswer || (() => {});
  const scroller = opts.scroller || log;
  let streamEl = null, streamRaw = '';

  const scrollDown = () => { scroller.scrollTop = scroller.scrollHeight; };

  function bubble(role, text) {
    const d = el('div', `j-msg ${role}`);
    if (role === 'bot') d.innerHTML = mdFmt(text || ''); else d.textContent = text || '';
    log.appendChild(d); scrollDown();
    return d;
  }
  function toolRow(name, inp) {
    streamEl = null;
    const d = el('div', 'j-tool'); d.textContent = `⏺ ${toolLabel(name, inp)}`;
    log.appendChild(d); scrollDown();
  }
  function appendStream(text) {
    if (!streamEl) { streamEl = bubble('bot', ''); streamRaw = ''; }
    streamRaw += text; streamEl.innerHTML = mdFmt(streamRaw); scrollDown();
  }
  function setStreamText(text) {
    if (!streamEl) return;
    streamRaw = text; streamEl.innerHTML = mdFmt(streamRaw); scrollDown();
  }
  const resetStream = () => { streamEl = null; streamRaw = ''; };
  const hasStream = () => !!streamEl;
  const streamText = () => streamRaw;
  const clear = () => { log.innerHTML = ''; resetStream(); };

  // AskUserQuestion -> render clickable options; a click answers via onAnswer.
  function renderQuestion(questions) {
    resetStream();
    for (const q of (questions || [])) {
      const wrap = el('div', 'j-q');
      if (q.question) { const t = el('div', 'j-q-text'); t.textContent = q.question; wrap.appendChild(t); }
      const opts2 = el('div', 'j-q-opts');
      const multi = !!q.multiSelect, chosen = new Set();
      const fire = (val) => { wrap.querySelectorAll('button').forEach((b) => { b.disabled = true; }); onAnswer(val); };
      for (const o of (q.options || [])) {
        const b = el('button', 'j-q-opt'); b.type = 'button'; b.textContent = o.label;
        if (o.description) b.title = o.description;
        b.addEventListener('click', () => {
          if (multi) { if (chosen.has(o.label)) { chosen.delete(o.label); b.classList.remove('sel'); } else { chosen.add(o.label); b.classList.add('sel'); } }
          else { b.classList.add('sel'); fire(o.label); }
        });
        opts2.appendChild(b);
      }
      if (multi) {
        const go = el('button', 'j-q-go'); go.type = 'button'; go.textContent = '✓ odeslat výběr';
        go.addEventListener('click', () => { if (chosen.size) fire([...chosen].join(', ')); });
        opts2.appendChild(go);
      }
      wrap.appendChild(opts2); log.appendChild(wrap); scrollDown();
    }
  }

  return { bubble, toolRow, appendStream, setStreamText, resetStream, hasStream, streamText, renderQuestion, scrollDown, clear };
}

// Parse an SSE byte stream (id/event/data lines; ': ' keepalive comments have
// no data line and are skipped). Resolves when the stream ends/errors.
export async function readSSE(resp, onFrame) {
  const reader = resp.body.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      let dataLine = null, evName = null;
      for (const line of frame.split('\n')) {
        if (line.startsWith('data:')) dataLine = line.slice(5).trim();
        else if (line.startsWith('event:')) evName = line.slice(6).trim();
      }
      if (dataLine == null) continue; // 'id:'-only frame / retry / ': ping'
      onFrame(evName, dataLine);
    }
  }
}
