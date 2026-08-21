/* MC v2 — globální Esc-chain. Vytaženo z app.js do vlastního modulu, aby
   moduly (drawer/viewer/jarvis/palette) neimportovaly entry (app.js) → žádný
   kruhový import (ten působil TDZ při fresh loadu přes HTTPS/Caddy).
   Priorita dle pořadí registrace: paleta (front=true) > viewer > drawer > jarvis. */
const escChain = [];
// {isOpen(), close()}; front=true zařadí handler na začátek (nejvyšší priorita)
export function pushEsc(handler, front) { front ? escChain.unshift(handler) : escChain.push(handler); }
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  for (const h of escChain) {
    if (h.isOpen()) { e.preventDefault(); h.close(); return; }
  }
});
