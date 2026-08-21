/* MC Core v0 — holografický glóbus v surovém WebGL (port hud.js, bez Three).
   ES module: import { initCore }(canvas,{mobile,reduced}) -> API */

const R = 1.28, CAMZ = 8.4, TILT = -0.40, SPIN = 0.16, MAXSEG = 32;

/* ---- GLSL (sdílený prelude: rotace + projekce) ---- */
const PRE = `precision mediump float;
uniform mat4 uProj;uniform vec2 uTilt;uniform float uSpin;
vec3 rotY(vec3 p,float a){float c=cos(a),s=sin(a);return vec3(c*p.x+s*p.z,p.y,-s*p.x+c*p.z);}
vec3 rotX(vec3 p,float a){float c=cos(a),s=sin(a);return vec3(p.x,c*p.y-s*p.z,s*p.y+c*p.z);}
vec3 rotZ(vec3 p,float a){float c=cos(a),s=sin(a);return vec3(c*p.x-s*p.y,s*p.x+c*p.y,p.z);}
vec3 rig(vec3 p){return rotX(rotZ(p,uTilt.y),uTilt.x);}
vec4 project(vec3 p){p=rig(p);p.z-=${CAMZ};return uProj*vec4(p,1.0);}
`;

const LINE_VS = PRE + `
attribute vec3 aPos;uniform float uBoot;varying float vA;
void main(){
  float lat=abs(aPos.y)/${(R * 1.02).toFixed(4)};
  float b=uBoot*1.15;
  vA=1.0-smoothstep(b-0.10,b+0.05,lat);
  gl_Position=project(rotY(aPos,uSpin));
}`;
const LINE_FS = `precision mediump float;
uniform vec3 uColor;uniform float uAlpha;varying float vA;
void main(){gl_FragColor=vec4(uColor,uAlpha*vA);}`;

const SHELL_VS = PRE + `
attribute vec3 aPos;uniform float uTime;varying vec3 vN;varying vec3 vV;varying float vY;
void main(){
  vec3 n=normalize(aPos);
  float disp=0.018*sin(uTime*1.4+aPos.y*5.0)+0.012*sin(uTime*2.1+aPos.x*6.0);
  vec3 p=rig(rotY(aPos+n*disp,uSpin));
  vN=rig(rotY(n,uSpin));
  vV=normalize(vec3(0.0,0.0,${CAMZ})-p);
  vY=aPos.y;
  gl_Position=uProj*vec4(p.x,p.y,p.z-${CAMZ},1.0);
}`;
const SHELL_FS = `precision mediump float;
uniform float uTime;uniform vec3 uColor;uniform float uGain;
varying vec3 vN;varying vec3 vV;varying float vY;
void main(){
  float fres=pow(1.0-max(dot(normalize(vV),normalize(vN)),0.0),2.7);
  float scan=0.62+0.38*sin(vY*22.0-uTime*2.1);
  float band=smoothstep(0.25,1.0,scan);
  float pulse=0.88+0.12*sin(uTime*1.5);
  float i=(fres*0.98+0.04)*(0.74+0.26*band)*pulse;
  gl_FragColor=vec4(uColor*i,clamp(i,0.0,0.66)*uGain);
}`;

/* mezikruží: prstence, pás, glow disk i pulzy */
const SOFT_VS = PRE + `
attribute vec2 aDir;attribute float aAv;attribute float aAu;
uniform float uR0,uR1,uPlane;varying float vAv;varying float vAu;varying float vZ;
void main(){
  float r=mix(uR0,uR1,aAv);vAv=aAv;vAu=aAu;
  if(uPlane>0.5){vZ=1.0;gl_Position=uProj*vec4(aDir.x*r,aDir.y*r,-${CAMZ},1.0);}
  else{
    vec3 w=rig(vec3(aDir.x*r,0.0,aDir.y*r));
    vZ=w.z/max(uR1,0.001);
    gl_Position=uProj*vec4(w.x,w.y,w.z-${CAMZ},1.0);
  }
}`;
const SOFT_FS = `precision mediump float;
uniform vec3 uColor;uniform vec3 uHot;
uniform float uAlpha,uShape,uTime,uSegN,uPhase;
uniform float uSeg[${MAXSEG}];
varying float vAv;varying float vAu;varying float vZ;
void main(){
  float a;vec3 col;
  if(uShape>0.5){a=pow(max(0.0,1.0-vAv),2.3);col=mix(uHot,uColor,smoothstep(0.0,0.55,vAv));}
  else{a=pow(sin(clamp(vAv,0.0,1.0)*3.14159),1.5);col=uColor;}
  a*=mix(0.30,1.0,smoothstep(-0.6,0.6,vZ));
  if(uSegN>0.5){
    float x=fract(vAu+uPhase);
    float idx=min(floor(x*uSegN),uSegN-1.0);
    float st=0.0;
    for(int k=0;k<${MAXSEG};k++){if(float(k)==idx)st=uSeg[k];}
    float f=fract(x*uSegN);
    float g=0.0075*uSegN;
    a*=smoothstep(g*0.35,g,f)*smoothstep(g*0.35,g,1.0-f);
    if(st<0.5){col=mix(uColor,vec3(1.0),0.55);}
    else if(st<1.5){col=vec3(1.0,0.69,0.13);}
    else if(st<2.5){col=vec3(1.0,0.30,0.37);a*=0.55+0.45*(0.5+0.5*sin(uTime*7.5398));}
    else{col=vec3(0.42,0.52,0.60);a*=0.45;}
  }
  gl_FragColor=vec4(col,a*uAlpha);
}`;

const POINT_VS = PRE + `
attribute vec3 aPos;attribute float aSeed;
uniform float uSize,uPx,uTime;varying float vTw;
void main(){
  vec4 cp=project(rotY(aPos,uSpin));
  gl_Position=cp;
  gl_PointSize=uSize*uPx/max(cp.w,0.001);
  vTw=0.55+0.45*abs(sin(uTime*1.3+aSeed*6.2832));
}`;
const POINT_FS = `precision mediump float;
uniform vec3 uColor;uniform float uAlpha;varying float vTw;
void main(){
  vec2 q=gl_PointCoord-0.5;float d=length(q)*2.0;
  float a=pow(max(0.0,1.0-d),1.9);
  gl_FragColor=vec4(mix(uColor,vec3(1.0),0.4*max(0.0,1.0-d*1.4)),a*uAlpha*vTw);
}`;

/* ---- 2D fallback (port z hud.js) ---- */
function make2D(canvas, accent, reduced) {
  const ctx = canvas.getContext('2d');
  const st = { accent: accent.slice(), intensity: 1 };
  let raf = 0, dead = false;
  function draw(once) {
    if (dead || !ctx) return;
    const w = canvas.width = canvas.clientWidth || 600, h = canvas.height = canvas.clientHeight || 600;
    const t = Date.now() / 1000, Rr = Math.min(w, h) * 0.28;
    ctx.clearRect(0, 0, w, h);
    const c = `${Math.round(st.accent[0] * 255)},${Math.round(st.accent[1] * 255)},${Math.round(st.accent[2] * 255)}`;
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Rr);
    g.addColorStop(0, `rgba(${c},${Math.min(1, (0.5 + Math.sin(t * 3) * 0.2) * st.intensity)})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(w / 2, h / 2, Rr, 0, 7); ctx.fill();
    ctx.strokeStyle = `rgba(${c},0.5)`; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.ellipse(w / 2, h / 2, Rr * 1.3, Rr * 0.45, 0, 0, 7); ctx.stroke();
    if (!once) raf = requestAnimationFrame(() => draw(false));
  }
  if (reduced) draw(true); else raf = requestAnimationFrame(() => draw(false));
  // změna boxu (reduced kreslí jen 1×; animace si rozměry čte každý frame)
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(() => { if (reduced) draw(true); }); ro.observe(canvas); }
  return {
    setAccent(c) { if (c) { st.accent = [(c.r || 0) / 255, (c.g || 0) / 255, (c.b || 0) / 255]; if (reduced) draw(true); } },
    setIntensity(x) { st.intensity = Math.max(0, Math.min(2, +x || 0)); if (reduced) draw(true); },
    setSegments() {}, pulse() {}, setActivity() {},
    boot(cb) { if (cb) setTimeout(cb, reduced ? 0 : 500); },
    destroy() { dead = true; cancelAnimationFrame(raf); if (ro) { ro.disconnect(); ro = null; } },
  };
}

/* ---- init ---- */
export function initCore(canvas, opts) {
  opts = opts || {};
  const reduced = !!opts.reduced, mobile = !!opts.mobile;
  const ACC = [43 / 255, 168 / 255, 255 / 255];
  let gl = null;
  try {
    gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: 'high-performance' })
      || canvas.getContext('experimental-webgl');
  } catch (e) { gl = null; }
  if (!gl) { console.warn('MCCore: WebGL nedostupný → 2D fallback'); return make2D(canvas, ACC, reduced); }

  let cur; // aktivní implementace (GL, po ztrátě kontextu 2D)

  /* -- shader helpers -- */
  function sh(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('MCCore shader: ' + gl.getShaderInfoLog(s));
    return s;
  }
  function prog(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('MCCore link: ' + gl.getProgramInfoLog(p));
    return {
      p, _u: {},
      u(n) { if (!(n in this._u)) this._u[n] = gl.getUniformLocation(p, n); return this._u[n]; },
      a(n) { return gl.getAttribLocation(p, n); },
    };
  }
  function buf(arr, elem) {
    const tgt = elem ? gl.ELEMENT_ARRAY_BUFFER : gl.ARRAY_BUFFER;
    const b = gl.createBuffer(); gl.bindBuffer(tgt, b); gl.bufferData(tgt, arr, gl.STATIC_DRAW); return b;
  }

  let pLine, pShell, pSoft, pPoint;
  try { pLine = prog(LINE_VS, LINE_FS); pShell = prog(SHELL_VS, SHELL_FS); pSoft = prog(SOFT_VS, SOFT_FS); pPoint = prog(POINT_VS, POINT_FS); }
  catch (e) { console.warn('MCCore: shader fail → 2D fallback', e); return make2D(canvas, ACC, reduced); }

  /* -- geometrie -- */
  const GR = R * 1.02;
  function sph(r, th, ph) { return [r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph), r * Math.sin(ph) * Math.sin(th)]; }
  // glóbus: 24 meridiánů × 12 rovnoběžek × 48 seg, GL_LINES
  const gv = [];
  for (let m = 0; m < 24; m++) {
    const th = m / 24 * Math.PI * 2;
    for (let s = 0; s < 48; s++) gv.push(...sph(GR, th, s / 48 * Math.PI), ...sph(GR, th, (s + 1) / 48 * Math.PI));
  }
  for (let p = 1; p < 12; p++) {
    const ph = p / 12 * Math.PI;
    for (let s = 0; s < 48; s++) gv.push(...sph(GR, s / 48 * Math.PI * 2, ph), ...sph(GR, (s + 1) / 48 * Math.PI * 2, ph));
  }
  const globeBuf = buf(new Float32Array(gv)), globeN = gv.length / 3;

  // UV koule 32×24 pro fresnel shell
  const sv = [], si = [], SW = 32, SH = 24;
  for (let y = 0; y <= SH; y++) for (let x = 0; x <= SW; x++) sv.push(...sph(R, x / SW * Math.PI * 2, y / SH * Math.PI));
  for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
    const a = y * (SW + 1) + x, b = a + SW + 1;
    si.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const shellBuf = buf(new Float32Array(sv)), shellIdx = buf(new Uint16Array(si), true), shellN = si.length;

  // mezikruží-strip, 64 seg, attrs dir.xy+av+au
  const av = [];
  for (let i = 0; i <= 64; i++) {
    const a = i / 64 * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    av.push(c, s, 0, i / 64, c, s, 1, i / 64);
  }
  const softBuf = buf(new Float32Array(av)), softN = av.length / 4;

  // body: 48 uzlů na povrchu + roj (pos.xyz + seed)
  function cloud(n, fr) {
    const a = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1), [x, y, z] = fr(th, ph);
      a[i * 4] = x; a[i * 4 + 1] = y; a[i * 4 + 2] = z; a[i * 4 + 3] = Math.random();
    }
    return a;
  }
  const nodeBuf = buf(cloud(48, (th, ph) => sph(GR, th, ph))), nodeN = 48;
  const swarmCnt = mobile ? 220 : 400;
  const swarmBuf = buf(cloud(swarmCnt, (th, ph) => { const r = 2.4 + Math.random() * 1.7, p = sph(r, th, ph); p[1] *= 0.7; return p; }));

  /* -- stav -- */
  const st = {
    accent: ACC.slice(), intensity: 1, activity: 1,
    seg: new Float32Array(MAXSEG), segN: 0,
    pulses: [], boot: 1, bootMs: -1, bootCb: null,
    t: 0, last: performance.now(), spin: 0, swarm: 0,
    curX: 0, curY: 0, tgX: 0, tgY: 0,
    degraded: false, fr: [], fI: 0, fSum: 0,
    raf: 0, dead: false,
  };
  let proj = new Float32Array(16), pxScale = 1, ro = null;
  const dprCap = mobile ? 1.5 : 2;

  function resize() {
    let w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) {
      // bez layoutu (skrytý canvas / před 1. layoutem): rozměry rodiče mají
      // jiný poměr stran → trvale zborcená projekce („vejce" na iOS).
      // S ResizeObserverem počkáme na skutečný box; fallback jen bez něj.
      if (ro) return;
      w = w || (canvas.parentElement && canvas.parentElement.clientWidth) || 600;
      h = h || (canvas.parentElement && canvas.parentElement.clientHeight) || 600;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, st.degraded ? 1 : dprCap);
    canvas.width = Math.max(2, Math.round(w * dpr)); canvas.height = Math.max(2, Math.round(h * dpr));
    gl.viewport(0, 0, canvas.width, canvas.height);
    // perspektivní matice ručně (fov 45°, near .1, far 100)
    const f = 1 / Math.tan(Math.PI / 8), n = 0.1, fa = 100, asp = canvas.width / canvas.height;
    proj.set([f / asp, 0, 0, 0, 0, f, 0, 0, 0, 0, (fa + n) / (n - fa), -1, 0, 0, 2 * fa * n / (n - fa), 0]);
    pxScale = canvas.height * 0.5 * f;
  }

  /* -- draw helpery -- */
  let frTx = TILT, frTz = 0, enabled = [];
  function shared(P, spin, tx, tz) {
    gl.useProgram(P.p);
    gl.uniformMatrix4fv(P.u('uProj'), false, proj);
    gl.uniform2f(P.u('uTilt'), tx === undefined ? frTx : tx, tz === undefined ? frTz : tz);
    gl.uniform1f(P.u('uSpin'), spin || 0);
  }
  function attr(P, name, b, size, stride, off) {
    const l = P.a(name); if (l < 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.enableVertexAttribArray(l);
    gl.vertexAttribPointer(l, size, gl.FLOAT, false, stride, off);
    enabled.push(l);
  }
  function flushAttrs() { while (enabled.length) gl.disableVertexAttribArray(enabled.pop()); }

  const ZSEG = new Float32Array(MAXSEG);
  function drawSoft(o) {
    const P = pSoft;
    shared(P, 0, o.tx, o.tz);
    gl.uniform1f(P.u('uR0'), o.r0); gl.uniform1f(P.u('uR1'), o.r1);
    gl.uniform1f(P.u('uPlane'), o.plane || 0); gl.uniform1f(P.u('uShape'), o.shape || 0);
    gl.uniform3fv(P.u('uColor'), o.color); gl.uniform3fv(P.u('uHot'), o.hot || o.color);
    gl.uniform1f(P.u('uAlpha'), o.alpha); gl.uniform1f(P.u('uTime'), st.t);
    gl.uniform1f(P.u('uSegN'), o.segN || 0); gl.uniform1f(P.u('uPhase'), o.phase || 0);
    gl.uniform1fv(P.u('uSeg[0]'), o.segN ? st.seg : ZSEG);
    attr(P, 'aDir', softBuf, 2, 16, 0); attr(P, 'aAv', softBuf, 1, 16, 8); attr(P, 'aAu', softBuf, 1, 16, 12);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, softN);
    flushAttrs();
  }
  function drawPoints(b, n, spin, size, color, alpha, tx, tz) {
    const P = pPoint;
    shared(P, spin, tx, tz);
    gl.uniform1f(P.u('uSize'), size); gl.uniform1f(P.u('uPx'), pxScale);
    gl.uniform1f(P.u('uTime'), st.t);
    gl.uniform3fv(P.u('uColor'), color); gl.uniform1f(P.u('uAlpha'), alpha);
    attr(P, 'aPos', b, 3, 16, 0); attr(P, 'aSeed', b, 1, 16, 12);
    gl.drawArrays(gl.POINTS, 0, n);
    flushAttrs();
  }

  /* -- render jednoho snímku -- */
  function render(dt, nowMs) {
    st.t += dt;
    const t = st.t;
    let bootE = st.boot;
    if (st.bootMs >= 0) {
      // boot podle reálných hodin (odolné vůči řídkému rAF)
      bootE = Math.min(1, (nowMs - st.bootMs) / 500);
      st.boot = bootE;
      if (bootE >= 1) {
        st.bootMs = -1;
        firePulse(0); // závěrečná vlnoplocha bootu
        const cb = st.bootCb; st.bootCb = null; if (cb) setTimeout(cb, 0);
      }
    }
    const ease = bootE * bootE * (3 - 2 * bootE);
    st.curX += (st.tgX - st.curX) * 0.05; st.curY += (st.tgY - st.curY) * 0.05;
    frTx = TILT + st.curY * 0.22; frTz = st.curX * 0.10;
    st.spin += dt * SPIN * (2.0 - ease); // boot: spin-up 2x → 1x
    st.swarm += dt * 0.05 * st.activity;
    const spinD = st.spin + st.curX * 0.5;
    const I = st.intensity, A = st.accent;
    const HOT = [0.92, 0.96, 1.0];

    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE);

    // 1) glow disk (fake bloom, čelem ke kameře)
    drawSoft({ plane: 1, shape: 1, r0: 0, r1: 2.15 + Math.sin(t * 1.5) * 0.14, color: [A[0] * 0.45 + 0.04, A[1] * 0.5 + 0.10, A[2] * 0.55 + 0.30], hot: [0.77, 0.87, 1.0], alpha: 0.50 * ease * I, tx: 0, tz: 0 });
    // 2) jasné jádro
    drawSoft({ plane: 1, shape: 1, r0: 0, r1: 0.42 * (0.9 + 0.12 * Math.sin(t * 1.6)), color: [0.45, 0.65, 1.0], hot: [0.86, 0.93, 1.0], alpha: 0.62 * ease * I, tx: 0, tz: 0 });
    // 3) fresnel shell
    {
      const P = pShell; shared(P, spinD);
      gl.uniform1f(P.u('uTime'), t); gl.uniform3fv(P.u('uColor'), A); gl.uniform1f(P.u('uGain'), I * (0.3 + 0.7 * ease));
      attr(P, 'aPos', shellBuf, 3, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, shellIdx);
      gl.drawElements(gl.TRIANGLES, shellN, gl.UNSIGNED_SHORT, 0);
      flushAttrs();
    }
    // 4) lat/long wireframe
    {
      const P = pLine; shared(P, spinD);
      gl.uniform3fv(P.u('uColor'), A); gl.uniform1f(P.u('uAlpha'), 0.40 * I); gl.uniform1f(P.u('uBoot'), ease);
      attr(P, 'aPos', globeBuf, 3, 0, 0);
      gl.drawArrays(gl.LINES, 0, globeN);
      flushAttrs();
    }
    // 5) tři prstence (statické na rigu)
    const rings = [[R * 1.20, 0.032, 0.80], [R * 1.42, 0.017, 0.45], [R * 1.62, 0.011, 0.25]];
    for (const [r, hw, op] of rings) drawSoft({ r0: r - hw, r1: r + hw, color: A, alpha: op * I * (0.25 + 0.75 * ease) });
    // 6) rovníkový pás se segmenty stavů
    const bhw = st.segN ? 0.038 : 0.028;
    drawSoft({
      r0: GR - bhw, r1: GR + bhw, color: HOT, alpha: 0.78 * I * ease,
      segN: st.segN, phase: st.segN ? (1 - ease) * 1.5 + t * 0.02 : 0, // pomalý drift
    });
    // 7) povrchové uzly
    drawPoints(nodeBuf, nodeN, spinD, 0.062, [0.90, 0.95, 1.0], 0.9 * I * ease);
    // 8) částicový roj (vynechán při degradaci)
    if (!st.degraded) drawPoints(swarmBuf, swarmCnt, st.swarm, 0.042, A, 0.5 * I * ease, frTx + Math.sin(t * 0.1) * 0.12, frTz);
    // 9) pulzy — expandující vlnoplochy, pool 3 (reálné hodiny)
    for (let i = st.pulses.length - 1; i >= 0; i--) {
      const p = st.pulses[i], k = (nowMs - p.t0) / 900;
      if (k >= 1) { st.pulses.splice(i, 1); continue; }
      const e = 1 - (1 - k) * (1 - k);
      const r = R * 1.05 + e * R * 1.65, hw = 0.05 + 0.22 * k;
      const cols = [[0.92, 0.97, 1.0], [1.0, 0.69, 0.13], [1.0, 0.30, 0.37]];
      drawSoft({ r0: r - hw, r1: r + hw, color: cols[p.sev] || cols[0], alpha: Math.pow(1 - k, 1.6) * 0.9 * I });
    }
  }

  function firePulse(sev) {
    if (st.pulses.length >= 3) st.pulses.shift();
    st.pulses.push({ t0: performance.now(), sev: Math.max(0, Math.min(2, sev | 0)) });
  }

  /* -- smyčka + frame-budget guard -- */
  function loop() {
    if (st.dead) return;
    const now = performance.now();
    let dt = (now - st.last) / 1000; st.last = now;
    if (dt < 0) dt = 0; if (dt > 0.05) dt = 0.05;
    const ms = dt * 1000;
    if (st.fr.length < 120) { st.fr.push(ms); st.fSum += ms; }
    else {
      st.fSum += ms - st.fr[st.fI]; st.fr[st.fI] = ms; st.fI = (st.fI + 1) % 120;
      if (!st.degraded && st.fSum / 120 > 24) { st.degraded = true; resize(); } // jednosměrná degradace
    }
    render(dt, now);
    st.raf = requestAnimationFrame(loop);
  }
  function renderOnce() { st.last = performance.now(); render(0, st.last); }

  /* -- události -- */
  function onPtr(e) {
    st.tgX = (e.clientX / window.innerWidth - 0.5) * 2;
    st.tgY = (e.clientY / window.innerHeight - 0.5) * 2;
  }
  function onVis() {
    if (document.hidden) { cancelAnimationFrame(st.raf); st.raf = 0; }
    else if (!st.raf && !st.dead && !reduced) { st.last = performance.now(); st.raf = requestAnimationFrame(loop); }
  }
  function onResize() { resize(); if (reduced) renderOnce(); }
  function onLost(ev) {
    ev.preventDefault();
    teardown();
    // mrtvý GL canvas nedá 2D → klon
    const c2 = canvas.cloneNode(false);
    if (canvas.parentNode) canvas.parentNode.replaceChild(c2, canvas);
    cur = make2D(c2, st.accent, reduced);
  }
  function teardown() {
    st.dead = true;
    cancelAnimationFrame(st.raf); st.raf = 0;
    if (ro) { ro.disconnect(); ro = null; }
    window.removeEventListener('resize', onResize);
    window.removeEventListener('pointermove', onPtr);
    document.removeEventListener('visibilitychange', onVis);
    canvas.removeEventListener('webglcontextlost', onLost);
  }

  resize();
  window.addEventListener('resize', onResize);
  // iOS Safari: box canvasu se mění i bez window.resize (usazení vh po načtení,
  // sbalení lišty, orientace) → přepočet bufferu + projekce při každé změně boxu
  if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(onResize); ro.observe(canvas); }
  document.addEventListener('visibilitychange', onVis);
  canvas.addEventListener('webglcontextlost', onLost);
  if (!reduced) {
    window.addEventListener('pointermove', onPtr);
    st.raf = requestAnimationFrame(loop);
  } else {
    st.t = 0.8; renderOnce(); // reduced: jediný statický snímek, bez rAF
  }

  cur = {
    setAccent(c) { if (c) st.accent = [(c.r || 0) / 255, (c.g || 0) / 255, (c.b || 0) / 255]; if (reduced) renderOnce(); },
    setIntensity(x) { st.intensity = Math.max(0, Math.min(2, +x || 0)); if (reduced) renderOnce(); },
    setSegments(arr) {
      if (!arr || !arr.length) { st.segN = 0; }
      else {
        st.segN = Math.min(MAXSEG, arr.length);
        for (let i = 0; i < MAXSEG; i++) st.seg[i] = i < st.segN ? (arr[i] || 0) : 0;
      }
      if (reduced) renderOnce();
    },
    pulse(sev) { if (!reduced) firePulse(sev); },
    setActivity(x) { st.activity = Math.max(0.5, Math.min(2.5, +x || 1)); },
    boot(cb) {
      if (reduced) { renderOnce(); if (cb) setTimeout(cb, 0); return; }
      st.boot = 0; st.bootMs = performance.now(); st.bootCb = cb || null;
    },
    destroy() {
      teardown();
      const ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext();
    },
  };

  // delegace přes `cur` — API přežije výměnu implementace
  return {
    setAccent(c) { cur.setAccent(c); }, setIntensity(x) { cur.setIntensity(x); },
    setSegments(a) { cur.setSegments(a); }, pulse(s) { cur.pulse(s); },
    setActivity(x) { cur.setActivity(x); }, boot(cb) { cur.boot(cb); },
    destroy() { cur.destroy(); },
  };
}

