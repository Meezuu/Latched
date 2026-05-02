import { useState, useRef, useEffect, useMemo, useCallback, lazy, Suspense } from "react";
const Board3D = lazy(() => import("./Board3D"));
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import PLACEMENTS        from "./data/placements.json";
import PLACEMENTS_MIRROR from "./data/placements_mirror.json";

// Escape user-controlled strings before injecting into innerHTML/HTML templates.
// Prevents XSS from external GeoJSON fields (gym.name, gym.username) and
// third-party API responses (Nominatim address text).
function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const PROFILE_KEY = "tt_profile_v1";

// TB2 usernames that operate a Mirror layout board (layout_id=10).
// Add more as you identify them from the TB2 app or gym listings.
const KNOWN_MIRROR_GYMS = new Set([
  "VerticalVentures",   // Vertical Ventures St Pete, FL
]);

// ─── GYM DATA ────────────────────────────────────────────────────────────────
const TB2_GYMS_URL = "https://raw.githubusercontent.com/Stevie-Ray/hangtime-climbing-boards/main/geojson/tensionboardapp2.geojson";
const GYMS_CACHE_KEY = "tt_tb2_gyms_v1";
const HOME_GYM_KEY    = "tt_home_gym_v1";
const MY_PROBLEMS_KEY  = "tt_my_problems_v1";
const SESSIONS_KEY     = "tt_sessions_v1";
const ANGLE_KEY        = "tt_angle_v1";
const FELT_GRADE_KEY   = "tt_felt_grade_v1";
const SETTINGS_KEY     = "tt_settings_v1";
const GYMS_CACHE_TTL  = 24 * 60 * 60 * 1000;

function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

async function fetchGyms() {
  try {
    const cached = JSON.parse(localStorage.getItem(GYMS_CACHE_KEY) || "null");
    if (cached && Date.now() - cached.ts < GYMS_CACHE_TTL) return cached.data;
    const res  = await fetch(TB2_GYMS_URL);
    const json = await res.json();
    const data = json.features.map(f => ({
      id: f.id, name: f.properties.name, username: f.properties.username,
      lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0],
    }));
    localStorage.setItem(GYMS_CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
    return data;
  } catch { return []; }
}

// ─── THEME ────────────────────────────────────────────────────────────────────
const T = {
  bg:"#111111", bg2:"#171717", bg3:"#202020", bg4:"#2a2a2a",
  border:"#2e2e2e", border2:"#3a3a3a",
  text:"#f0e6d8", text2:"#9a8c80", text3:"#4a4040", white:"#f5ede2",
  purple:"#a855f7", purpleDim:"rgba(168,85,247,0.12)", purpleBrd:"rgba(168,85,247,0.38)",
  accentLight:"#a855f7",
  red:"#ff3c3c", blue:"#3c8eff", grey:"#444444",
};

// Two-tone fractal noise: dark burnt (#5c1200) ↔ vivid orange (#ff6b00)
const _NSRC = `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='4' stitchTiles='stitch' result='t'/><feColorMatrix type='saturate' values='0' in='t' result='g'/><feComponentTransfer in='g'><feFuncR type='table' tableValues='0.36 1.00'/><feFuncG type='table' tableValues='0.07 0.42'/><feFuncB type='table' tableValues='0.00 0.00'/></feComponentTransfer></filter><rect width='160' height='160' filter='url(%23n)'/></svg>`;
const NOISE_BG = { backgroundImage:`url("data:image/svg+xml,${encodeURIComponent(_NSRC)}")`, backgroundSize:"160px 160px" };

const R = 10;

const ROLE_COLOR = { start:"#22c55e", hand:"#3b82f6", finish:"#ef4444", foot:"#a855f7" };
const GRADES = ["V0","V1","V2","V3","V4","V5","V6","V7","V8","V9","V10","V11","V12","V13","V14","V15"];
const ALL_ANGLES = [0,5,10,15,20,25,30,35,40,45,50,55,60,65];
const ANGLES = [20,25,30,35,40,45,50,55];

const TABS   = ["Map","Climbs","Profile","Stats"];
const ROLES  = ["start","hand","finish","foot"];


const IMG_ASPECT = 1144 / 1080;

// Preload board images at module level so they're ready before any Board mounts
const WOOD_IMG    = new Image(); WOOD_IMG.src    = "/tb2-wood.png";
const PLASTIC_IMG = new Image(); PLASTIC_IMG.src = "/tb2-plastic.png";

const SAMPLE_PROBLEMS = [
  { id:"my-1", name:"Pizza Box", grade:"V3", angle:40, style:["Technical"],
    attempts:3, sends:1, liked:true, notes:"Classic beginner benchmark",
    holds:[{id:852,role:"finish"},{id:858,role:"foot"},{id:1090,role:"foot"},
      {id:1098,role:"hand"},{id:1116,role:"foot"},{id:1119,role:"foot"},
      {id:1122,role:"start"},{id:1124,role:"hand"},{id:1125,role:"hand"},
      {id:1132,role:"hand"},{id:1143,role:"hand"},{id:1146,role:"hand"},{id:1197,role:"foot"}] },
];

// ─── LOGO ─────────────────────────────────────────────────────────────────────
// ─── LOGO VARIANTS ────────────────────────────────────────────────────────────
// Shared particle-stroke props: round-capped dashes simulate sand grains
const P  = { strokeLinecap:"round", strokeDasharray:"1 2.8",   fill:"none" };
const PT = { strokeLinecap:"round", strokeDasharray:"0.6 2.2", fill:"none" };

// A: (2,2) Chladni — central diamond + 4 corner circular nodes
function LogoA({ size=32 }) {
  const nodes = [[13,13],[51,13],[51,51],[13,51]];
  return (
    <svg width={size} height={size} viewBox="0 0 64 64">
      <defs><clipPath id="la"><circle cx="32" cy="32" r="32"/></clipPath></defs>
      <circle cx="32" cy="32" r="32" fill="#060410"/>
      <g clipPath="url(#la)" stroke="white" fill="none" strokeLinecap="round">
        <polygon points="32,17 47,32 32,47 17,32" strokeWidth="1.1" {...P}/>
        {nodes.map(([cx,cy],i)=><circle key={i} cx={cx} cy={cy} r="8.5" strokeWidth="1.1" {...P}/>)}
        <line x1="32" y1="17" x2="19" y2="13" strokeWidth="0.7" {...PT} opacity="0.55"/>
        <line x1="47" y1="32" x2="51" y2="19" strokeWidth="0.7" {...PT} opacity="0.55"/>
        <line x1="32" y1="47" x2="45" y2="51" strokeWidth="0.7" {...PT} opacity="0.55"/>
        <line x1="17" y1="32" x2="13" y2="45" strokeWidth="0.7" {...PT} opacity="0.55"/>
        <circle cx="32" cy="32" r="3.5" strokeWidth="0.8" {...P} opacity="0.6"/>
      </g>
    </svg>
  );
}

// B: Interference rings — 2 concentric circles + 4 spokes + node dots
function LogoB({ size=32 }) {
  const cardinals = [0,90,180,270].map(d => d*Math.PI/180);
  const diags     = [45,135,225,315].map(d => d*Math.PI/180);
  return (
    <svg width={size} height={size} viewBox="0 0 64 64">
      <defs><clipPath id="lb"><circle cx="32" cy="32" r="32"/></clipPath></defs>
      <circle cx="32" cy="32" r="32" fill="#060410"/>
      <g clipPath="url(#lb)" stroke="white" fill="none" strokeLinecap="round">
        <circle cx="32" cy="32" r="26" strokeWidth="1.3" {...P}/>
        <circle cx="32" cy="32" r="12" strokeWidth="1"   {...P}/>
        {cardinals.map((a,i)=>(
          <line key={i}
            x1={32+12*Math.cos(a)} y1={32+12*Math.sin(a)}
            x2={32+26*Math.cos(a)} y2={32+26*Math.sin(a)}
            strokeWidth="0.8" {...PT} opacity="0.7"/>
        ))}
        {diags.map((a,i)=>(
          <circle key={i} cx={32+12*Math.cos(a)} cy={32+12*Math.sin(a)}
            r="1.8" fill="white" stroke="none"/>
        ))}
        {diags.map((a,i)=>(
          <circle key={i} cx={32+26*Math.cos(a)} cy={32+26*Math.sin(a)}
            r="1.4" fill="white" stroke="none" opacity="0.7"/>
        ))}
        <circle cx="32" cy="32" r="2" fill="white" stroke="none"/>
      </g>
    </svg>
  );
}

// C: Hexagonal resonance — 6 orbital nodes + inner ring
function LogoC({ size=32 }) {
  const hex = Array.from({length:6},(_,i)=>{
    const a=(i*60-90)*Math.PI/180;
    return [32+19*Math.cos(a), 32+19*Math.sin(a)];
  });
  return (
    <svg width={size} height={size} viewBox="0 0 64 64">
      <defs><clipPath id="lc"><circle cx="32" cy="32" r="32"/></clipPath></defs>
      <circle cx="32" cy="32" r="32" fill="#060410"/>
      <g clipPath="url(#lc)" stroke="white" fill="none" strokeLinecap="round">
        {hex.map(([cx,cy],i)=><circle key={i} cx={cx} cy={cy} r="6.5" strokeWidth="1.1" {...P}/>)}
        {hex.map(([cx,cy],i)=>{
          const [nx,ny]=hex[(i+1)%6];
          return <line key={i} x1={cx} y1={cy} x2={nx} y2={ny} strokeWidth="0.65" {...PT} opacity="0.5"/>;
        })}
        {hex.map(([cx,cy],i)=>(
          <line key={i} x1="32" y1="32" x2={32+0.55*(cx-32)} y2={32+0.55*(cy-32)}
            strokeWidth="0.5" {...PT} opacity="0.4"/>
        ))}
        <circle cx="32" cy="32" r="5" strokeWidth="1" {...P}/>
      </g>
    </svg>
  );
}

// D: Cross standing-wave — 2 perpendicular S-curves with 4 end nodes
function LogoD({ size=32 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64">
      <defs><clipPath id="ld"><circle cx="32" cy="32" r="32"/></clipPath></defs>
      <circle cx="32" cy="32" r="32" fill="#060410"/>
      <g clipPath="url(#ld)" stroke="white" fill="none" strokeLinecap="round">
        <path d="M8,32 C16,22 26,22 32,32 C38,42 48,42 56,32" strokeWidth="1.1" {...P}/>
        <path d="M32,8 C42,16 42,26 32,32 C22,38 22,48 32,56" strokeWidth="1.1" {...P}/>
        {[[8,32],[56,32],[32,8],[32,56]].map(([cx,cy],i)=>(
          <circle key={i} cx={cx} cy={cy} r="6.5" strokeWidth="1" {...P}/>
        ))}
        <circle cx="32" cy="32" r="3" strokeWidth="0.9" {...P} opacity="0.7"/>
      </g>
    </svg>
  );
}

// E: 3-ring target with cardinal and diagonal particle dots
function LogoE({ size=32 }) {
  const rings=[8,16,25];
  const angles8=Array.from({length:8},(_,i)=>i*45*Math.PI/180);
  return (
    <svg width={size} height={size} viewBox="0 0 64 64">
      <defs><clipPath id="le"><circle cx="32" cy="32" r="32"/></clipPath></defs>
      <circle cx="32" cy="32" r="32" fill="#060410"/>
      <g clipPath="url(#le)" stroke="white" fill="none" strokeLinecap="round">
        {rings.map((r,i)=>(
          <circle key={i} cx="32" cy="32" r={r}
            strokeWidth={i===2?1.3:0.9} {...P} opacity={i===2?1:0.8}/>
        ))}
        {angles8.map((a,i)=>{
          const r=i%2===0?16:25;
          return <circle key={i} cx={32+r*Math.cos(a)} cy={32+r*Math.sin(a)}
            r="1.6" fill="white" stroke="none" opacity={i%2===0?1:0.6}/>;
        })}
        {[0,90,180,270].map((d,i)=>{
          const a=d*Math.PI/180;
          return <line key={i}
            x1={32+8*Math.cos(a)} y1={32+8*Math.sin(a)}
            x2={32+16*Math.cos(a)} y2={32+16*Math.sin(a)}
            strokeWidth="0.7" {...PT} opacity="0.5"/>;
        })}
        <circle cx="32" cy="32" r="2" fill="white" stroke="none"/>
      </g>
    </svg>
  );
}

// F: OG image geometry — 8-circle ring + connecting arcs + central diamond
function LogoF({ size=32 }) {
  const cx=32, cy=32, Rr=14, cr=4, di=6.5;
  const pts = Array.from({length:8}, (_,i) => {
    const a=(i*45-90)*Math.PI/180;
    return { x:cx+Rr*Math.cos(a), y:cy+Rr*Math.sin(a) };
  });
  const arcs = pts.map((p1,i) => {
    const p2=pts[(i+1)%8];
    const mx=(p1.x+p2.x)/2, my=(p1.y+p2.y)/2;
    const cpx=mx+(cx-mx)*0.38, cpy=my+(cy-my)*0.38;
    return `M${p1.x.toFixed(1)},${p1.y.toFixed(1)} Q${cpx.toFixed(1)},${cpy.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }).join(' ');
  const diamond=`M${cx},${cy-di} L${cx+di},${cy} L${cx},${cy+di} L${cx-di},${cy} Z`;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64">
      <defs>
        <clipPath id="lf"><circle cx="32" cy="32" r="32"/></clipPath>
        <filter id="gf" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="1.4" result="b"/>
          <feFlood floodColor="#ffffff" floodOpacity="0.75" result="c"/>
          <feComposite in="c" in2="b" operator="in" result="glow"/>
          <feMerge><feMergeNode in="glow"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <circle cx="32" cy="32" r="32" fill="#060410"/>
      <g clipPath="url(#lf)" filter="url(#gf)" stroke="white" fill="none" strokeLinecap="round" opacity="0.82">
        {pts.map((p,i)=><circle key={i} cx={p.x.toFixed(1)} cy={p.y.toFixed(1)} r={cr} strokeWidth="1" {...P}/>)}
        <path d={diamond} strokeWidth="1" {...P}/>
        <path d={arcs} strokeWidth="0.75" {...PT} opacity="0.85"/>
      </g>
    </svg>
  );
}

// Active Logo — change this letter to switch: A B C D E F
const LOGO_VARIANT = "F";
const LOGO_MAP = { A:LogoA, B:LogoB, C:LogoC, D:LogoD, E:LogoE, F:LogoF };
function Logo({ size=32 }) {
  const L = LOGO_MAP[LOGO_VARIANT] ?? LogoA;
  return <L size={size}/>;
}

// Temporary gallery — remove once variant is chosen
function LogoGallery() {
  const variants = [
    { id:"A", L:LogoA, label:"DIAMOND + NODES" },
    { id:"B", L:LogoB, label:"INTERFERENCE" },
    { id:"C", L:LogoC, label:"HEXAGONAL" },
    { id:"D", L:LogoD, label:"CROSS WAVE" },
    { id:"E", L:LogoE, label:"3 RINGS" },
  ];
  return (
    <div style={{ background:"#08060f", borderBottom:"1px solid #1a1030",
      padding:"14px 8px 10px", display:"flex", gap:0, justifyContent:"center" }}>
      {variants.map(({id,L,label})=>(
        <div key={id} style={{ display:"flex", flexDirection:"column",
          alignItems:"center", gap:5, padding:"0 10px" }}>
          <L size={52}/>
          <div style={{ fontFamily:"'Geist Mono',monospace", fontSize:9,
            color:"#a855f7", letterSpacing:"0.12em", fontWeight:700 }}>{id}</div>
          <div style={{ fontFamily:"'Geist Mono',monospace", fontSize:6.5,
            color:"#443355", letterSpacing:"0.07em" }}>{label}</div>
        </div>
      ))}
    </div>
  );
}

// ─── SPLASH ───────────────────────────────────────────────────────────────────
function SplashScreen({ onDone }) {
  const [phase, setPhase] = useState("in"); // "in" | "hold" | "out"

  useEffect(() => {
    // fade in: 0–600ms (CSS handles it via phase="in" → opacity 1)
    // hold at full opacity: 600–1400ms
    // fade out everything: 1400–2200ms
    // unmount: 2200ms
    const t1 = setTimeout(() => setPhase("out"), 1400);
    const t2 = setTimeout(() => onDone(),         2200);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []); // eslint-disable-line

  return (
    <div style={{ position:"fixed", inset:0, zIndex:9999, pointerEvents:"none",
      background:"#000",
      opacity: phase === "out" ? 0 : 1,
      transition: phase === "out" ? "opacity 0.8s ease-in" : "none",
      display:"flex", alignItems:"center", justifyContent:"center",
    }}>
      <div style={{
        fontFamily:"'Geist',sans-serif", fontWeight:800,
        fontSize:15, letterSpacing:"0.28em", textTransform:"uppercase",
        color:"rgba(255,255,255,0.88)",
        opacity: phase === "in" ? 1 : 1,
        animation: "tt-fadein 0.6s ease both",
      }}>La<span style={{color:"#a855f7"}}>t</span>ched</div>
      <style>{`@keyframes tt-fadein { from { opacity:0; } to { opacity:1; } }`}</style>
    </div>
  );
}

// ─── BOARD (canvas) ───────────────────────────────────────────────────────────
const BETA_COLORS = { left:"#3b82f6", right:"#f97316", match:"#22c55e" };

function Board({ problem, editMode, editRole, onHoldTap, placements = PLACEMENTS, mirrorLayout = false,
                 betaMode = false, betaAssignments = {}, onBetaHoldTap }) {
  const containerRef = useRef(null);
  const canvasRef    = useRef(null);
  const [w, setW]    = useState(320);
  const [ready, setReady] = useState(WOOD_IMG.complete && PLASTIC_IMG.complete);

  useEffect(() => {
    if (ready) return;
    let n = 0;
    const done = () => { if (++n === 2) setReady(true); };
    WOOD_IMG.addEventListener("load",    done, { once: true });
    PLASTIC_IMG.addEventListener("load", done, { once: true });
    if (WOOD_IMG.complete)    done();
    if (PLASTIC_IMG.complete) done();
  }, [ready]);

  useEffect(() => {
    const ro = new ResizeObserver(() => {
      if (containerRef.current) setW(containerRef.current.offsetWidth);
    });
    if (containerRef.current) { setW(containerRef.current.offsetWidth); ro.observe(containerRef.current); }
    return () => ro.disconnect();
  }, []);

  const h = Math.round(w * IMG_ASPECT);

  useEffect(() => {
    if (!canvasRef.current || !ready || w < 10) return;
    const canvas = canvasRef.current;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width  = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    // Build active hold lookup
    const activeMap = {};
    (problem?.holds || []).forEach(hh => { activeMap[hh.id] = hh.role; });
    const hasActive = Object.keys(activeMap).length > 0;

    // ── 1. Dark base — matches the 3D board's #1c1c1c surface
    ctx.fillStyle = "#161616";
    ctx.fillRect(0, 0, w, h);

    // ── 2. Board images — flip horizontally for mirror layout
    if (mirrorLayout) {
      ctx.save();
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
      ctx.globalAlpha = 0.58; ctx.drawImage(WOOD_IMG,    0, 0, w, h);
      ctx.globalAlpha = 0.68; ctx.drawImage(PLASTIC_IMG, 0, 0, w, h);
      ctx.restore();
    } else {
      ctx.globalAlpha = 0.58; ctx.drawImage(WOOD_IMG,    0, 0, w, h);
      ctx.globalAlpha = 0.68; ctx.drawImage(PLASTIC_IMG, 0, 0, w, h);
    }
    ctx.globalAlpha = 1;

    // Mirror boards are mounted in the opposite orientation — same hole coordinates
    // in the DB, but physically left↔right swapped when facing the board.
    // Flip the canvas x so holds render from the viewer's perspective.
    const px = (normX) => mirrorLayout ? (1 - normX / 100) * w : (normX / 100) * w;
    const py = (normY) => (normY / 100) * h;

    // ── 3. Grid — ring outline for every hold position, always visible
    const dotR = Math.max(3, w * 0.011);
    ctx.globalAlpha = hasActive ? 0.18 : 0.38;
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth   = 0.9;
    Object.values(placements).forEach(p => {
      ctx.beginPath(); ctx.arc(px(p.x), py(p.y), dotR, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.globalAlpha = 1;

    // ── 4. Slight darken when problem active so colored holds pop
    if (hasActive) {
      ctx.fillStyle = "rgba(0,0,0,0.40)";
      ctx.fillRect(0, 0, w, h);
    }

    // ── 5. Colored holds with bloom glow — role-specific shapes
    //       In beta mode, skip hand holds (beta overlay handles them); foot stays purple
    if (hasActive) {
      const r = Math.max(6.5, w * 0.024);

      Object.entries(placements).forEach(([pid, p]) => {
        const role = activeMap[Number(pid)];
        if (!role) return;
        // In beta mode, only draw foot holds here — hand-relevant holds drawn in step 6
        if (betaMode && role !== "foot") return;
        const color  = ROLE_COLOR[role];
        const cx     = px(p.x);
        const cy     = py(p.y);
        const isFoot   = role === "foot";
        const isFinish = role === "finish";
        const isStart  = role === "start";
        const hr = isFoot ? r * 0.72 : r;

        ctx.save();

        // ── bloom: two shadow passes for soft halo
        ctx.shadowColor = color;
        ctx.shadowBlur  = isFoot ? 14 : 30;
        ctx.strokeStyle = color;
        ctx.lineWidth   = isFoot ? 2.0 : 3.0;
        ctx.globalAlpha = isFoot ? 0.75 : 1.0;

        if (isFinish) {
          // finish: outer dashed ring
          ctx.setLineDash([4, 3]);
          ctx.beginPath(); ctx.arc(cx, cy, hr + 5, 0, Math.PI * 2); ctx.stroke();
          ctx.setLineDash([]);
          ctx.shadowBlur = 12;
        }

        // main ring
        ctx.beginPath(); ctx.arc(cx, cy, hr, 0, Math.PI * 2); ctx.stroke();

        if (isStart) {
          // start: inner concentric ring to mark "begin here"
          ctx.shadowBlur = 8;
          ctx.lineWidth  = 1.5;
          ctx.beginPath(); ctx.arc(cx, cy, hr * 0.50, 0, Math.PI * 2); ctx.stroke();
        }

        // fill
        ctx.shadowBlur  = 0;
        ctx.fillStyle   = color;
        ctx.globalAlpha = isFoot ? 0.28 : 0.42;
        ctx.beginPath(); ctx.arc(cx, cy, hr, 0, Math.PI * 2); ctx.fill();

        // center pip — anchors the hold visually
        ctx.globalAlpha = isFoot ? 0.70 : 1.0;
        ctx.fillStyle   = color;
        ctx.beginPath(); ctx.arc(cx, cy, isFoot ? 1.5 : 2.2, 0, Math.PI * 2); ctx.fill();

        ctx.restore();
      });
    }

    // ── 6. Beta mode overlay — colours holds by hand assignment
    if (betaMode && problem?.holds) {
      const handRoles = new Set(["start","hand","finish"]);
      const br = Math.max(7, w * 0.026);
      problem.holds.forEach(hh => {
        if (!handRoles.has(hh.role)) return;
        const p = placements[hh.id]; if (!p) return;
        const cx = px(p.x), cy = py(p.y);
        const asgn  = betaAssignments[hh.id];
        const color = asgn ? BETA_COLORS[asgn] : null;
        ctx.save();
        if (color) {
          ctx.shadowColor = color; ctx.shadowBlur = 22;
          ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.globalAlpha = 1;
        } else {
          ctx.strokeStyle = "rgba(255,255,255,0.30)"; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.65;
        }
        ctx.beginPath(); ctx.arc(cx, cy, br, 0, Math.PI*2); ctx.stroke();
        if (color) {
          ctx.shadowBlur = 0; ctx.fillStyle = color; ctx.globalAlpha = 0.28;
          ctx.beginPath(); ctx.arc(cx, cy, br, 0, Math.PI*2); ctx.fill();
          ctx.globalAlpha = 1; ctx.fillStyle = color;
          ctx.font = `700 ${Math.max(8,w*0.021)}px 'Geist Mono',monospace`;
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText(asgn === "match" ? "M" : asgn[0].toUpperCase(), cx, cy);
        }
        ctx.restore();
      });
    }

    // ── 7. Legend strip (only when a problem is active)
    if (hasActive) {
      const entries = [["START", ROLE_COLOR.start], ["HAND", ROLE_COLOR.hand], ["FINISH", ROLE_COLOR.finish], ["FOOT", ROLE_COLOR.foot]];
      const padX = 8, padY = h - 20, dotLR = 4, gap = 6;
      // semi-transparent backing pill
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.beginPath();
      const pillW = entries.length * 60 + 4, pillH = 14;
      ctx.roundRect(padX - 4, padY - 9, pillW, pillH, 3);
      ctx.fill();

      entries.forEach(([label, color], i) => {
        const lx = padX + i * 60;
        const ly = padY;
        // ring swatch
        ctx.beginPath(); ctx.arc(lx + dotLR, ly, dotLR, 0, Math.PI * 2);
        ctx.fillStyle   = color + "30"; ctx.fill();
        ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.stroke();
        // label
        ctx.fillStyle = "rgba(255,255,255,0.70)";
        ctx.font = `600 7px 'Geist Mono', monospace`;
        ctx.fillText(label, lx + dotLR * 2 + gap, ly + 2.5);
      });
    }

  }, [problem, w, h, ready, placements, mirrorLayout, betaMode, betaAssignments]);

  // Hit-target SVG — used for both edit mode and beta logging mode
  const svgHolds = useMemo(() => Object.entries(placements).map(([pid, p]) => ({
    id: Number(pid),
    cx: mirrorLayout ? (1 - p.x / 100) * w : (p.x / 100) * w,
    cy: (p.y / 100) * h,
  })), [w, h, placements, mirrorLayout]);

  // In beta mode, only expose hand-relevant holds as tap targets
  const betaHoldIds = useMemo(() => {
    if (!betaMode || !problem?.holds) return new Set();
    return new Set(problem.holds.filter(h => ["start","hand","finish"].includes(h.role)).map(h => h.id));
  }, [betaMode, problem]);

  const hitR = Math.max(10, w * 0.03);

  return (
    <div ref={containerRef} style={{ width:"100%", position:"relative" }}>
      <canvas ref={canvasRef} style={{ display:"block", width:"100%", borderRadius:R, border:`1px solid ${T.border}` }}/>
      {editMode && (
        <svg style={{ position:"absolute", inset:0, width:"100%", height:"100%", pointerEvents:"all" }}>
          {svgHolds.map(h => (
            <circle key={h.id} cx={h.cx} cy={h.cy} r={hitR}
              fill="transparent" style={{ cursor:"pointer" }}
              onClick={() => onHoldTap(h.id)}/>
          ))}
        </svg>
      )}
      {betaMode && (
        <svg style={{ position:"absolute", inset:0, width:"100%", height:"100%", pointerEvents:"all" }}>
          {svgHolds.filter(h => betaHoldIds.has(h.id)).map(h => (
            <circle key={h.id} cx={h.cx} cy={h.cy} r={hitR}
              fill="transparent" style={{ cursor:"pointer" }}
              onClick={() => onBetaHoldTap?.(h.id)}/>
          ))}
        </svg>
      )}
    </div>
  );
}

// ─── ANGLE SELECTOR ───────────────────────────────────────────────────────────
function AngleSel({ value, onChange }) {
  const desc = value<=25?"Past Vertical":value<=35?"Slight Overhang":value<=42?"Moderate Overhang":value<=48?"Steep Overhang":"Cave / Max";
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-end" }}>
        <span style={{ fontSize:9, color:T.text3, fontFamily:"'Geist Mono',monospace", letterSpacing:"0.12em", textTransform:"uppercase" }}>Board Angle</span>
        <div style={{ display:"flex", alignItems:"baseline", gap:2 }}>
          <span style={{ fontFamily:"'Geist',sans-serif", fontWeight:800, fontSize:32, color:T.white, lineHeight:1 }}>{value}</span>
          <span style={{ fontFamily:"'Geist',sans-serif", fontWeight:800, fontSize:14, color:T.purple }}>°</span>
        </div>
      </div>
      <div style={{ display:"flex", gap:3 }}>
        {ANGLES.map(a => (
          <button key={a} onClick={() => onChange(a)} style={{
            flex:1, background:a===value?T.white:T.bg3,
            border:`1px solid ${a===value?T.white:T.border}`,
            color:a===value?T.bg:T.text3, borderRadius:R, padding:"5px 0",
            fontSize:10, cursor:"pointer", fontFamily:"'Geist Mono',monospace",
            fontWeight:a===value?700:400, transition:"all 0.1s",
          }}>{a}</button>
        ))}
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
        <svg width={40} height={40} viewBox="0 0 40 40">
          <line x1="4" y1="36" x2="36" y2="36" stroke={T.border2} strokeWidth="1.5" strokeLinecap="round"/>
          <line x1="4" y1="36"
            x2={4+Math.sin(value*Math.PI/180)*30} y2={36-Math.cos(value*Math.PI/180)*30}
            stroke={T.white} strokeWidth="1.8" strokeLinecap="round"/>
          <circle cx="4" cy="36" r="2" fill={T.purple}/>
        </svg>
        <span style={{ fontSize:10, color:T.text2, fontFamily:"'Geist Mono',monospace" }}>{desc} · {value}°</span>
      </div>
    </div>
  );
}

function GradePill({ grade, sent, small }) {
  return (
    <span style={{
      fontFamily:"'Geist Mono',monospace", fontSize:small?8:9, fontWeight:700,
      color:sent?T.bg:T.purple, ...(sent?NOISE_BG:{background:T.purpleDim}),
      border:`1px solid ${sent?T.purple:T.purpleBrd}`,
      padding:small?"1px 5px":"2px 7px", borderRadius:3,
      letterSpacing:"0.05em",
    }}>{grade}</span>
  );
}

function Feel({ val, onClick }) {
  return (
    <div style={{ display:"flex", gap:3 }}>
      {[1,2,3,4,5].map(i => (
        <div key={i} onClick={onClick?()=>onClick(i):undefined} style={{
          width:6, height:6, borderRadius:"50%",
          background:i<=val?T.white:T.bg3,
          border:`1px solid ${i<=val?T.white:T.border}`,
          cursor:onClick?"pointer":"default",
        }}/>
      ))}
    </div>
  );
}

// ─── GYM DATA (social links keyed by TB2 username) ───────────────────────────
// Add more gyms here as they're confirmed. All fields optional except username.
// Add more gyms here as they're confirmed. Keys must match the TB2 username field.
// address/phone/email values skip the Nominatim geocoding fetch.
const GYM_DATA = {
  // ── Florida ──────────────────────────────────────────────────────────────────
  VerticalVentures: {
    websiteUrl:   "https://verticalventures.com/",
    instagramUrl: "https://www.instagram.com/verticalventures/",
    youtubeUrl:   null,
    tiktokUrl:    null,
    phone:        "(727) 304-6290",
    email:        "stpete@verticalventures.com",
    address:      "116 18th Street South, St. Petersburg, FL 33712",
  },
  blueswanboulders: {
    websiteUrl:   "https://blueswanboulders.com/",
    instagramUrl: "https://www.instagram.com/blueswanboulders/",
    youtubeUrl:   "https://www.youtube.com/@momentsclimbing",
    tiktokUrl:    null,
    phone:        "(407) 601-0752",
    email:        "blueswanboulders@momentsclimbing.com",
    address:      "400 Pittman St., Suite 103, Orlando, FL 32801",
  },
  aiguilleclimbing: {
    websiteUrl:   "https://www.aiguille.com/",
    instagramUrl: "https://www.instagram.com/aiguilleclimbing/",
    youtubeUrl:   "https://www.youtube.com/user/AiguilleRocks",
    tiktokUrl:    null,
    phone:        "(407) 332-1430",
    email:        "operations@aiguille.com",
    address:      "830 S. Ronald Reagan Blvd., Suite 252, Longwood, FL 32750",
  },
  theedgerockgymmel: {
    websiteUrl:   "https://ontheedgerockclimbing.com/",
    instagramUrl: "https://www.instagram.com/theedgerockgymmel/",
    youtubeUrl:   null,
    tiktokUrl:    null,
    phone:        "(321) 724-8775",
    email:        "ontheedgerockclimbing@gmail.com",
    address:      "200 West Drive, Melbourne, FL 32904",
  },
  centralrockcitruspark: {
    websiteUrl:   "https://centralrockgym.com/citrus-park/",
    instagramUrl: "https://www.instagram.com/centralrockcitruspark/",
    youtubeUrl:   "https://www.youtube.com/user/TheCentralRockTV",
    tiktokUrl:    "https://www.tiktok.com/@centralrockgym",
    phone:        "(813) 475-4043",
    email:        "citruspark@centralrockgym.com",
    address:      "6918 Gunn Highway, Tampa, FL 33625",
  },
  highpoint_orlando: {
    websiteUrl:   "https://www.highpointclimbing.com/locations/orlando",
    instagramUrl: "https://www.instagram.com/highpointorlandofl/",
    youtubeUrl:   "https://www.youtube.com/user/highpointclimbing",
    tiktokUrl:    null,
    phone:        "(689) 306-9021",
    email:        "orlando@highpointclimbing.com",
    address:      "1978 Stanhome Way, Orlando, FL 32804",
  },
  centralrockfortmyers: {
    websiteUrl:   "https://centralrockgym.com/fort-myers/",
    instagramUrl: "https://www.instagram.com/centralrockfortmyers/",
    youtubeUrl:   "https://www.youtube.com/user/TheCentralRockTV",
    tiktokUrl:    "https://www.tiktok.com/@centralrockgym",
    phone:        "(239) 837-0505",
    email:        "fortmyers@centralrockgym.com",
    address:      "6150 Exchange Ln., Fort Myers, FL 33912",
  },
  stoneclimbing_jax: {
    websiteUrl:   "https://stoneclimbing.com/",
    instagramUrl: "https://www.instagram.com/stoneclimbingco/",
    youtubeUrl:   null,
    tiktokUrl:    null,
    phone:        "(904) 660-2909",
    email:        null,
    address:      "10575 Deerwood Park Blvd., Jacksonville, FL 32256",
  },
  blockerbouldersjacksonville: {
    websiteUrl:   "https://www.blockerboulders.com/",
    instagramUrl: "https://www.instagram.com/blockerbouldersjacksonville/",
    youtubeUrl:   null,
    tiktokUrl:    null,
    phone:        "(904) 371-8521",
    email:        "contact@blockerboulders.com",
    address:      "6500 Bowden Rd., Suite 100, Jacksonville, FL 32216",
  },
};

function getGymData(gym) {
  return GYM_DATA[gym.username] || {};
}

function getGymLogo(gym) {
  const d = getGymData(gym);
  return d.logoUrl || null;
}

function gymLetterAvatar(gym, size) {
  const letter = (gym.name || "?").charAt(0).toUpperCase();
  let hash = 0;
  for (const c of gym.name || "") hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
  const hue = Math.abs(hash) % 360;
  return `<div style="width:${size}px;height:${size}px;border-radius:6px;background:hsl(${hue},35%,22%);display:flex;align-items:center;justify-content:center;font-family:'Geist',sans-serif;font-weight:800;font-size:${Math.round(size*0.42)}px;color:hsl(${hue},55%,65%);flex-shrink:0;">${escHtml(letter)}</div>`;
}

function GymAvatar({ gym, size = 34 }) {
  const [err, setErr] = useState(false);
  const logo = getGymLogo(gym);
  const letter = (gym.name || "?").charAt(0).toUpperCase();
  let hash = 0;
  for (const c of gym.name || "") hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
  const hue = Math.abs(hash) % 360;
  if (logo && !err) {
    return <img src={logo} alt="" onError={() => setErr(true)} style={{
      width:size, height:size, borderRadius:R, objectFit:"contain",
      background:"#fff", flexShrink:0,
    }}/>;
  }
  return (
    <div style={{
      width:size, height:size, borderRadius:R, flexShrink:0,
      background:`hsl(${hue},35%,22%)`,
      display:"flex", alignItems:"center", justifyContent:"center",
      fontFamily:"'Geist',sans-serif", fontWeight:800,
      fontSize:Math.round(size*0.42), color:`hsl(${hue},55%,65%)`,
    }}>{letter}</div>
  );
}

function SetterAvatar({ username, size = 40 }) {
  let hash = 0;
  for (const c of username || "") hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
  const hue = Math.abs(hash) % 360;
  return (
    <div style={{
      width:size, height:size, borderRadius:"50%", flexShrink:0,
      background:`hsl(${hue},38%,16%)`,
      border:`2px solid hsl(${hue},42%,28%)`,
      display:"flex", alignItems:"center", justifyContent:"center",
      fontFamily:"'Geist',sans-serif", fontWeight:800,
      fontSize:Math.round(size * 0.4), color:`hsl(${hue},58%,62%)`,
    }}>
      {(username || "?").charAt(0).toUpperCase()}
    </div>
  );
}

// ─── ADDRESS CACHE ───────────────────────────────────────────────────────────
const addressCache = {};

async function getAddress(gymId, lat, lng) {
  if (gymId in addressCache) return addressCache[gymId];
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lng=${lng}&format=json&addressdetails=1&accept-language=en`,
      { headers: { "User-Agent": "Latched/1.0 (climbing board app)" } }
    );
    if (!r.ok) { addressCache[gymId] = null; return null; }
    const j = await r.json();
    const a = j.address || {};
    const road   = [a.house_number, a.road].filter(Boolean).join(' ');
    const city   = a.city || a.town || a.village || a.municipality || a.county || '';
    const region = [a.state, a.country_code?.toUpperCase()].filter(Boolean).join(', ');
    const line2  = [city, region].filter(Boolean).join(', ');
    addressCache[gymId] = [road, line2].filter(Boolean).join('\n') || null;
  } catch {
    addressCache[gymId] = null;
  }
  return addressCache[gymId];
}

// ─── GYM MAP ─────────────────────────────────────────────────────────────────
function GymMap({ homeGym, onSetHomeGym, onSeeGymClimbs }) {
  const containerRef = useRef(null);
  const mapRef       = useRef(null);
  const markersRef   = useRef({});
  const [gyms, setGyms]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState("");
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    fetchGyms().then(data => { setGyms(data); setLoading(false); });
  }, []);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    mapRef.current = L.map(containerRef.current, { zoomControl: true }).setView([25, 10], 2);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution:'© <a href="https://carto.com/">CARTO</a>', maxZoom:19,
    }).addTo(mapRef.current);
  }, []);

  const buildPopupHtml = useCallback((gym, isHome) => {
    const logo = getGymLogo(gym);
    const data = getGymData(gym);
    const avatarHtml = logo
      ? `<img src="${logo}" alt="" onerror="this.style.display='none';this.nextSibling.style.display='flex';" style="width:44px;height:44px;border-radius:6px;object-fit:contain;background:#fff;flex-shrink:0;"/>
         <div style="display:none;${gymLetterAvatar(gym,44).slice(5)}`
      : gymLetterAvatar(gym, 44);

    const addrText = data.address || (addressCache[gym.id] ? addressCache[gym.id].replace('\n', ', ') : null);
    const addrLine = addrText
      ? `<div style="font-size:10px;color:#888;line-height:1.5;margin-top:4px;">${escHtml(addrText)}</div>`
      : `<div style="font-size:9px;color:#444;font-family:'Geist Mono',monospace;margin-top:4px;" data-addr-id="${escHtml(String(gym.id))}">loading address…</div>`;

    // Build social links — only include ones with real URLs
    const linkStyle = "display:flex;align-items:center;gap:6px;padding:7px 10px;background:#1e1e1e;border:1px solid #2e2e2e;border-radius:4px;text-decoration:none;font-size:9px;font-family:'Geist Mono',monospace;letter-spacing:0.06em;color:#aaa;flex:1;white-space:nowrap;";
    const mapsLink = `<a href="https://www.google.com/maps/search/?api=1&query=${gym.lat},${gym.lng}" target="_blank" rel="noopener" style="${linkStyle}color:#7a7aff;">
      <svg width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>
      MAPS</a>`;
    const webLink = data.websiteUrl
      ? `<a href="${data.websiteUrl}" target="_blank" rel="noopener" style="${linkStyle}">
          <svg width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          WEB</a>`
      : "";
    const igLink = data.instagramUrl
      ? `<a href="${data.instagramUrl}" target="_blank" rel="noopener" style="${linkStyle}">
          <svg width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="5"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>
          IG</a>`
      : "";
    const ytLink = data.youtubeUrl
      ? `<a href="${data.youtubeUrl}" target="_blank" rel="noopener" style="${linkStyle}color:#ff4444;">
          <svg width="10" height="10" fill="currentColor" viewBox="0 0 24 24"><path d="M23 7s-.3-2-1.2-2.7c-1.1-1.2-2.4-1.2-3-1.3C16.2 3 12 3 12 3s-4.2 0-6.8.1c-.6.1-1.9.1-3 1.3C1.3 5 1 7 1 7S.7 9.1.7 11.3v2c0 2.1.3 4.3.3 4.3s.3 2 1.2 2.7c1.1 1.2 2.6 1.1 3.3 1.2C7.2 21.7 12 21.7 12 21.7s4.2 0 6.8-.2c.6-.1 1.9-.1 3-1.3.9-.7 1.2-2.7 1.2-2.7s.3-2.1.3-4.3v-2C23.3 9.1 23 7 23 7zM9.7 15.5V8.2l8.1 3.7-8.1 3.6z"/></svg>
          YT</a>`
      : "";
    const ttLink = data.tiktokUrl
      ? `<a href="${data.tiktokUrl}" target="_blank" rel="noopener" style="${linkStyle}">
          <svg width="10" height="10" fill="currentColor" viewBox="0 0 24 24"><path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1V9.01a6.31 6.31 0 0 0-.79-.05 6.34 6.34 0 0 0-6.34 6.34 6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.33-6.34V8.69a8.18 8.18 0 0 0 4.77 1.52V6.76a4.86 4.86 0 0 1-1-.07z"/></svg>
          TT</a>`
      : "";
    const phoneLink = data.phone
      ? `<a href="tel:${data.phone.replace(/\D/g,'')}" style="${linkStyle}">
          <svg width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 9.91a16 16 0 0 0 6.18 6.18l.91-.91a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
          CALL</a>`
      : "";
    const emailLink = data.email
      ? `<a href="mailto:${data.email}" style="${linkStyle}">
          <svg width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
          EMAIL</a>`
      : "";

    const socialLinks = [mapsLink, webLink, igLink, ytLink, ttLink, phoneLink, emailLink].filter(Boolean);

    return `
    <div style="font-family:'Geist',sans-serif;color:#e8e8e8;background:#181818;border-radius:6px;overflow:hidden;width:296px;">
      <div style="padding:14px;border-bottom:1px solid #242424;">
        <div style="display:flex;align-items:flex-start;gap:12px;">
          ${avatarHtml}
          <div style="flex:1;min-width:0;">
            <div style="font-weight:700;font-size:13px;color:#f0f0f0;line-height:1.25;letter-spacing:-0.01em;">${escHtml(gym.name)}</div>
            <div style="font-size:8px;color:#444;font-family:'Geist Mono',monospace;letter-spacing:0.08em;margin-top:2px;">@${escHtml(gym.username)}</div>
            ${addrLine}
          </div>
        </div>
      </div>

      <div style="padding:10px 14px;border-bottom:1px solid #1e1e1e;">
        <div style="display:flex;gap:5px;flex-wrap:wrap;">
          ${socialLinks.join("")}
        </div>
      </div>

      <div style="padding:10px 14px 12px;display:flex;flex-direction:column;gap:5px;">
        <button data-action="set-home-gym"
          style="width:100%;padding:8px 0;background:${isHome?"rgba(168,85,247,0.18)":"transparent"};border:1px solid ${isHome?"rgba(168,85,247,0.5)":"#2a2a2a"};color:${isHome?"#a855f7":"#666"};border-radius:4px;font-size:8px;font-family:'Geist Mono',monospace;letter-spacing:0.08em;cursor:pointer;font-weight:700;">
          ${isHome ? "▲ HOME GYM" : "SET AS HOME GYM"}
        </button>
        <button data-action="see-gym-climbs"
          style="width:100%;padding:8px 0;background:rgba(168,85,247,0.12);border:1px solid rgba(168,85,247,0.35);color:#9333ea;border-radius:4px;font-size:8px;font-family:'Geist Mono',monospace;letter-spacing:0.08em;cursor:pointer;font-weight:700;">
          VIEW ALL CLIMBS →
        </button>
      </div>
    </div>`;
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || gyms.length === 0) return;

    gyms.forEach(gym => {
      const isHome = homeGym?.id === gym.id;
      const icon = L.divIcon({
        className: "",
        html: `<div style="width:${isHome?14:9}px;height:${isHome?14:9}px;border-radius:50%;background:${isHome?"#a855f7":"#6b21a8"};border:${isHome?"2.5px solid #c084fc":"1.5px solid #7e22ce"};box-shadow:0 0 ${isHome?10:5}px ${isHome?"#a855f7aa":"#6b21a866"};"></div>`,
        iconSize: isHome ? [14,14] : [9,9],
        iconAnchor: isHome ? [7,7] : [4.5,4.5],
      });

      const marker = L.marker([gym.lat, gym.lng], { icon })
        .addTo(map)
        .bindPopup(L.popup({ maxWidth:320, className:"tt-popup" })
          .setContent(buildPopupHtml(gym, isHome)));

      marker.on('popupopen', () => {
        // Attach button handlers via DOM delegation — no window globals, no inline JS
        const el = marker.getPopup()?.getElement();
        if (el) {
          const homeBtn   = el.querySelector('[data-action="set-home-gym"]');
          const climbsBtn = el.querySelector('[data-action="see-gym-climbs"]');
          if (homeBtn)   homeBtn.onclick   = () => { onSetHomeGym(gym); map.closePopup(); };
          if (climbsBtn) climbsBtn.onclick = () => { onSeeGymClimbs(); map.closePopup(); };
        }

        // Fetch address when popup opens — skip if curated address exists in GYM_DATA
        const d = getGymData(gym);
        if (d.address || gym.id in addressCache) return;
        getAddress(gym.id, gym.lat, gym.lng).then(() => {
          const isH = homeGym?.id === gym.id;
          const popup = marker.getPopup();
          if (!popup) return;
          popup.setContent(buildPopupHtml(gym, isH));
          // Reattach after content rebuild (new DOM nodes replace old ones)
          const el2 = popup.getElement();
          if (el2) {
            const hb = el2.querySelector('[data-action="set-home-gym"]');
            const cb = el2.querySelector('[data-action="see-gym-climbs"]');
            if (hb) hb.onclick = () => { onSetHomeGym(gym); map.closePopup(); };
            if (cb) cb.onclick = () => { onSeeGymClimbs(); map.closePopup(); };
          }
        });
      });

      markersRef.current[gym.id] = marker;
    });
  }, [gyms, homeGym, buildPopupHtml, onSetHomeGym, onSeeGymClimbs]);

  // Refresh home gym marker when it changes
  useEffect(() => {
    if (!mapRef.current || gyms.length === 0) return;
    gyms.forEach(gym => {
      const marker = markersRef.current[gym.id];
      if (!marker) return;
      const isHome = homeGym?.id === gym.id;
      const icon = L.divIcon({
        className: "",
        html: `<div style="width:${isHome?14:9}px;height:${isHome?14:9}px;border-radius:50%;background:${isHome?"#a855f7":"#6b21a8"};border:${isHome?"2.5px solid #c084fc":"1.5px solid #7e22ce"};box-shadow:0 0 ${isHome?10:5}px ${isHome?"#a855f7aa":"#6b21a866"};"></div>`,
        iconSize: isHome ? [14,14] : [9,9], iconAnchor: isHome ? [7,7] : [4.5,4.5],
      });
      marker.setIcon(icon);
      marker.getPopup()?.setContent(buildPopupHtml(gym, isHome));
    });
  }, [homeGym, gyms, buildPopupHtml]);

  const filtered = useMemo(() =>
    search ? gyms.filter(g => g.name.toLowerCase().includes(search.toLowerCase())) : gyms,
    [gyms, search]);

  function flyTo(gym) {
    setSelected(gym);
    mapRef.current?.flyTo([gym.lat, gym.lng], 13, { duration:1.2 });
    setTimeout(() => markersRef.current[gym.id]?.openPopup(), 1300);
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10, flex:1, overflow:"hidden", padding:"14px" }}>
      {homeGym && (
        <div style={{ background:"rgba(168,85,247,0.06)", border:`1px solid rgba(168,85,247,0.22)`, borderRadius:6, padding:"10px 13px", display:"flex", alignItems:"center", gap:10 }}>
          <GymAvatar gym={homeGym} size={32}/>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:12, fontFamily:"'Geist',sans-serif", fontWeight:700, color:T.white, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{homeGym.name}</div>
            <div style={{ fontSize:8, color:T.text3, fontFamily:"'Geist Mono',monospace", letterSpacing:"0.07em", marginTop:2 }}>HOME · @{homeGym.username}</div>
          </div>
          <button onClick={() => onSetHomeGym(null)} style={{ background:"none", border:"none", color:T.text3, cursor:"pointer", fontSize:8, fontFamily:"'Geist Mono',monospace", letterSpacing:"0.06em", flexShrink:0, padding:"4px 0" }}>CHANGE</button>
        </div>
      )}

      <input value={search} onChange={e => setSearch(e.target.value)}
        placeholder={loading ? "Loading gyms…" : `Search ${gyms.length} TB2 gyms worldwide…`}
        style={{ background:T.bg3, border:`1px solid ${T.border}`, color:T.text, borderRadius:R,
          padding:"9px 11px", fontSize:12, outline:"none", fontFamily:"'Geist',sans-serif", width:"100%", boxSizing:"border-box" }}/>

      <div ref={containerRef} style={{ flex:1, minHeight:200, borderRadius:R, overflow:"hidden", border:`1px solid ${T.border}` }}/>

      {search && filtered.length > 0 && (
        <div style={{ maxHeight:200, overflowY:"auto", display:"flex", flexDirection:"column", gap:4 }}>
          {filtered.slice(0, 50).map(gym => {
            const isHome = homeGym?.id === gym.id;
            return (
              <button key={gym.id} onClick={() => flyTo(gym)} style={{
                background:selected?.id===gym.id ? T.bg4 : T.bg2,
                border:`1px solid ${selected?.id===gym.id ? T.border2 : T.border}`,
                borderLeft:`3px solid ${isHome ? T.purple : selected?.id===gym.id ? T.border2 : T.border}`,
                borderRadius:R, padding:"8px 12px", cursor:"pointer", textAlign:"left",
                display:"flex", alignItems:"center", gap:8,
              }}>
                <GymAvatar gym={gym} size={30}/>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:12, fontFamily:"'Geist',sans-serif", fontWeight:700, color:T.text }}>{gym.name}</div>
                  <div style={{ fontSize:9, color:T.text3, fontFamily:"'Geist Mono',monospace", marginTop:2 }}>@{gym.username}</div>
                </div>
                {isHome && <span style={{ fontSize:10, color:T.purple }}>★</span>}
                <span style={{ fontSize:10, color:T.purple }}>→</span>
              </button>
            );
          })}
          {filtered.length > 50 && (
            <div style={{ fontSize:9, color:T.text3, fontFamily:"'Geist Mono',monospace", textAlign:"center", padding:"4px 0" }}>
              +{filtered.length - 50} more — narrow your search
            </div>
          )}
        </div>
      )}

      {!search && !loading && (
        <div style={{ fontSize:9, color:T.text3, fontFamily:"'Geist Mono',monospace", letterSpacing:"0.1em", textAlign:"center" }}>
          {gyms.length} TB2 GYMS WORLDWIDE · TAP A PIN TO SEE DETAILS
        </div>
      )}
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [splash, setSplash]         = useState(true);
  const [tab, setTab]               = useState("Map");
  const [myProblems, setMyProblems] = useState(() => lsGet(MY_PROBLEMS_KEY, []));
  const [sessions, setSessions]     = useState(() => lsGet(SESSIONS_KEY, []));
  const [angle, setAngle]           = useState(() => lsGet(ANGLE_KEY, 40));
  const [boardProblem, setBoardProblem] = useState(null);
  const [editMode, setEditMode]     = useState(false);
  const [editRole, setEditRole]     = useState("start");
  const [homeGym, setHomeGymState]  = useState(() => {
    try { return JSON.parse(localStorage.getItem(HOME_GYM_KEY)) || null; } catch { return null; }
  });

  const boardLayout = homeGym && KNOWN_MIRROR_GYMS.has(homeGym.username) ? "mirror" : "spray";

  const [climbs, setClimbs]                   = useState([]);
  const [climbsMirror, setClimbsMirror]       = useState([]);
  const [personalClimbs, setPersonalClimbs]   = useState([]);
  const [personalMirror, setPersonalMirror]   = useState([]);
  const [climbsLoading, setClimbsLoading]     = useState(true);

  const [profile, setProfile]               = useState(() => lsGet(PROFILE_KEY, { username:"", bio:"", avatarDataUrl:"" }));
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const [draftProfile, setDraftProfile]     = useState(null);

  const [logOpen, setLogOpen]               = useState(false);
  const [createOpen, setCreateOpen]         = useState(false);
  const [boardModalOpen, setBoardModalOpen] = useState(false);
  const [view3d, setView3d]               = useState(false);
  const [draftClimb, setDraftClimb]         = useState(null);
  const [draftRole, setDraftRole]           = useState("start");
  const [newSess, setNewSess]               = useState({ date:new Date().toISOString().slice(0,10), duration:60, feel:3, notes:"" });

  const [climbSource, setClimbSource]     = useState("community");
  const [gradeMin, setGradeMin]           = useState(null);
  const [gradeMax, setGradeMax]           = useState(null);
  const [filterAngle, setFilterAngle]     = useState(null); // single-select
  const [classicsOnly, setClassicsOnly]   = useState(false);
  const [filterSetter, setFilterSetter]   = useState(null);
  const [filterSent, setFilterSent]       = useState(null); // null|"sent"|"not-sent"|"project"
  const [filterMinAscents, setFilterMinAscents] = useState(null);
  const [filterMinQuality, setFilterMinQuality] = useState(null);
  const [filterDateAfter, setFilterDateAfter]   = useState("");
  const [filterDateBefore, setFilterDateBefore] = useState("");
  const [sortBy, setSortBy]               = useState("quality"); // quality|ascents|grade|date|difficulty
  const [filterOpen, setFilterOpen]       = useState(false);
  const [injuryLeft, setInjuryLeft]       = useState(false);
  const [injuryRight, setInjuryRight]     = useState(false);

  // Felt grade + settings
  const [feltGradeLog, setFeltGradeLog] = useState(() => lsGet(FELT_GRADE_KEY, {}));
  const [settings, setSettings]         = useState(() => lsGet(SETTINGS_KEY, { showFeltGrade: false }));
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Beta logging
  const [betaLog, setBetaLog]     = useState(() => lsGet("tt_beta_v1", {}));
  const [betaMode, setBetaMode]   = useState(false);
  const [betaDraft, setBetaDraft] = useState({});   // holdId → "left"|"right"|"match"
  const [betaHand, setBetaHand]   = useState("left");
  const [setterOpen, setSetterOpen]       = useState(false);
  const [setterSearch, setSetterSearch]   = useState("");
  const [search, setSearch]               = useState("");
  const [selectedClimb, setSelectedClimb] = useState(null);
  const [communityPage, setCommunityPage] = useState(30);
  const [attNote, setAttNote]             = useState("");
  const [toast, setToast]                 = useState(null);
  const [sendReview, setSendReview]       = useState(null); // { problem, grade, notes }

  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700;800;900&family=Geist+Mono:wght@400;500;700&display=swap";
    document.head.appendChild(link);
  }, []);

  useEffect(() => {
    setClimbsLoading(true);
    Promise.all([
      fetch("/data/climbs.json").then(r => r.json()).catch(() => []),
      fetch("/data/climbs_mirror.json").then(r => r.ok ? r.json() : []).catch(() => []),
      fetch("/data/personal_climbs.json").then(r => r.ok ? r.json() : []).catch(() => []),
      fetch("/data/personal_climbs_mirror.json").then(r => r.ok ? r.json() : []).catch(() => []),
    ]).then(([community, mirror, personal, personalMirrorData]) => {
      setClimbs(community);
      setClimbsMirror(mirror);
      setPersonalClimbs(personal);
      setPersonalMirror(personalMirrorData);
      setClimbsLoading(false);
    });
  }, []);

  function setHomeGym(gym) {
    setHomeGymState(gym);
    if (gym) localStorage.setItem(HOME_GYM_KEY, JSON.stringify(gym));
    else localStorage.removeItem(HOME_GYM_KEY);
  }


  function saveProfile(p) {
    setProfile(p);
    lsSet(PROFILE_KEY, p);
  }

  function handleSeeGymClimbs() {
    setFilterSetter(null);
    setClimbSource("community");
    setTab("Climbs");
  }

  useEffect(() => { lsSet(MY_PROBLEMS_KEY, myProblems); }, [myProblems]);
  useEffect(() => { lsSet(SESSIONS_KEY, sessions); }, [sessions]);
  useEffect(() => { lsSet(ANGLE_KEY, angle); }, [angle]);
  useEffect(() => { setBetaMode(false); setBetaDraft({}); }, [boardProblem]);

  const myClimbMap = useMemo(() => {
    const m = {};
    myProblems.forEach(p => { m[p.id] = p; });
    return m;
  }, [myProblems]);

  const activeCommunityClimbs = boardLayout === "mirror" ? climbsMirror : climbs;
  const activePersonalClimbs  = boardLayout === "mirror" ? personalMirror : personalClimbs;
  const isMirror = boardLayout === "mirror";

  const setterList = useMemo(() => {
    const m = {};
    activeCommunityClimbs.forEach(c => { m[c.setter] = (m[c.setter] || 0) + 1; });
    return Object.entries(m).sort((a,b) => b[1]-a[1]).map(([name, count]) => ({ name, count }));
  }, [activeCommunityClimbs]);

  const [setterProfile, setSetterProfile]       = useState(null);
  const [followedSetters, setFollowedSetters]   = useState(
    () => new Set(lsGet("tt_followed_setters_v1", []))
  );

  function toggleFollow(username) {
    setFollowedSetters(prev => {
      const next = new Set(prev);
      if (next.has(username)) next.delete(username); else next.add(username);
      lsSet("tt_followed_setters_v1", [...next]);
      return next;
    });
  }

  const setterClimbs = useMemo(() =>
    setterProfile
      ? activeCommunityClimbs.filter(c => c.setter === setterProfile).sort((a,b) => b.quality - a.quality)
      : [],
    [setterProfile, activeCommunityClimbs]
  );

  const filteredCommunity = useMemo(() => {
    const minIdx = gradeMin ? GRADES.indexOf(gradeMin) : 0;
    const maxIdx = gradeMax ? GRADES.indexOf(gradeMax) : GRADES.length - 1;
    const sq = search.toLowerCase();

    let result = activeCommunityClimbs.filter(c => {
      const gi = GRADES.indexOf(c.grade);
      if (gi < minIdx || gi > maxIdx) return false;
      if (filterAngle !== null && c.angle !== filterAngle) return false;
      if (classicsOnly && (c.quality < 3.0 || c.ascents < 200)) return false;
      if (filterSetter && c.setter !== filterSetter) return false;
      if (filterMinAscents && c.ascents < filterMinAscents) return false;
      if (filterMinQuality && c.quality < filterMinQuality) return false;
      if (filterDateAfter  && c.date && c.date < filterDateAfter)  return false;
      if (filterDateBefore && c.date && c.date > filterDateBefore) return false;
      if (filterSent === "sent"     && !myClimbMap[c.uuid]?.sends)   return false;
      if (filterSent === "not-sent" && myClimbMap[c.uuid]?.sends)    return false;
      if (filterSent === "project"  && (!myClimbMap[c.uuid] || myClimbMap[c.uuid]?.sends > 0)) return false;
      if (sq && !c.name.toLowerCase().includes(sq) && !c.setter.toLowerCase().includes(sq)) return false;

      // Injury filter — use logged beta when available, else positional heuristic
      if (injuryLeft || injuryRight) {
        const pl = isMirror ? PLACEMENTS_MIRROR : PLACEMENTS;
        const handRoles = new Set(["start", "hand", "finish"]);
        const loggedBeta = betaLog[c.uuid]?.holdAssignments;
        for (const hold of c.holds) {
          if (!handRoles.has(hold.role)) continue;
          let usesLeft = false, usesRight = false;
          if (loggedBeta?.[hold.id]) {
            const asgn = loggedBeta[hold.id];
            usesLeft  = asgn === "left"  || asgn === "match";
            usesRight = asgn === "right" || asgn === "match";
          } else {
            const p = pl[hold.id]; if (!p) continue;
            const visuallyLeft = isMirror ? p.x >= 50 : p.x < 50;
            usesLeft  = visuallyLeft;
            usesRight = !visuallyLeft;
          }
          if (injuryLeft  && usesLeft)  return false;
          if (injuryRight && usesRight) return false;
        }
      }

      return true;
    });

    result.sort((a, b) => {
      if (sortBy === "quality")    return b.quality - a.quality;
      if (sortBy === "ascents")    return b.ascents - a.ascents;
      if (sortBy === "difficulty") return (b.difficulty||0) - (a.difficulty||0);
      if (sortBy === "grade")      return GRADES.indexOf(b.grade) - GRADES.indexOf(a.grade);
      if (sortBy === "date")       return (b.date||"") < (a.date||"") ? -1 : 1;
      return 0;
    });

    return result;
  }, [activeCommunityClimbs, gradeMin, gradeMax, filterAngle, classicsOnly, filterSetter,
      filterMinAscents, filterMinQuality, filterDateAfter, filterDateBefore,
      filterSent, sortBy, search, myClimbMap, injuryLeft, injuryRight, isMirror, betaLog]);

  useEffect(() => { setCommunityPage(30); }, [gradeMin, gradeMax, filterAngle, classicsOnly, filterSetter,
    filterMinAscents, filterMinQuality, filterDateAfter, filterDateBefore, filterSent, sortBy, search]);

  useEffect(() => {
    if (createOpen) {
      setDraftClimb({ id:"draft", name:"", grade:"V7", angle:40, holds:[], style:"Technical", notes:"", match:true });
      setDraftRole("start");
    }
  }, [createOpen]);

  function tapDraftHold(holdId) {
    setDraftClimb(prev => {
      if (!prev) return prev;
      const ex = prev.holds.find(h => h.id === holdId);
      if (ex) {
        if (ex.role === draftRole) return {...prev, holds: prev.holds.filter(h => h.id !== holdId)};
        return {...prev, holds: prev.holds.map(h => h.id === holdId ? {...h, role: draftRole} : h)};
      }
      return {...prev, holds: [...prev.holds, {id: holdId, role: draftRole}]};
    });
  }

  function handleGradeTap(g) {
    const gi = GRADES.indexOf(g);
    const minI = gradeMin ? GRADES.indexOf(gradeMin) : -1;
    const maxI = gradeMax ? GRADES.indexOf(gradeMax) : -1;
    if (g === gradeMin) { setGradeMin(gradeMax); setGradeMax(null); return; }
    if (g === gradeMax) { setGradeMax(null); return; }
    if (minI === -1) { setGradeMin(g); return; }
    if (maxI === -1) { gi > minI ? setGradeMax(g) : setGradeMin(g); return; }
    if (gi < minI) { setGradeMin(g); return; }
    if (gi > maxI) { setGradeMax(g); return; }
    gi - minI <= maxI - gi ? setGradeMin(g) : setGradeMax(g);
  }

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  }

  // ── Beta logging ────────────────────────────────────────────────────────────
  function startBeta(problem) {
    const existing = problem?.uuid ? (betaLog[problem.uuid]?.holdAssignments ?? {}) : {};
    setBetaDraft(existing);
    setBetaHand("left");
    setBetaMode(true);
  }

  function tapBetaHold(holdId) {
    setBetaDraft(prev => {
      if (prev[holdId] === betaHand) { const n={...prev}; delete n[holdId]; return n; }
      return { ...prev, [holdId]: betaHand };
    });
  }

  function saveBeta() {
    if (!boardProblem?.uuid) return;
    const updated = { ...betaLog, [boardProblem.uuid]: { holdAssignments: betaDraft, updatedAt: Date.now() } };
    setBetaLog(updated);
    lsSet("tt_beta_v1", updated);
    setBetaMode(false);
    showToast("BETA SAVED ✓");
  }

  function clearBeta(uuid) {
    const updated = { ...betaLog };
    delete updated[uuid];
    setBetaLog(updated);
    lsSet("tt_beta_v1", updated);
    showToast("BETA CLEARED");
  }

  function saveFeltGrade(uuid, grade) {
    const updated = { ...feltGradeLog, [uuid]: grade };
    setFeltGradeLog(updated);
    lsSet(FELT_GRADE_KEY, updated);
  }
  function clearFeltGrade(uuid) {
    const updated = { ...feltGradeLog };
    delete updated[uuid];
    setFeltGradeLog(updated);
    lsSet(FELT_GRADE_KEY, updated);
  }
  function updateSetting(key, value) {
    const updated = { ...settings, [key]: value };
    setSettings(updated);
    lsSet(SETTINGS_KEY, updated);
  }

  function commitSend(problem, grade, notes) {
    const isPersonal = !!problem.id && !problem.uuid;
    if (isPersonal) {
      setMyProblems(prev => prev.map(p => p.id !== problem.id ? p :
        {...p, attempts:p.attempts+1, sends:p.sends+1, grade, notes}));
      if (boardProblem?.id === problem.id)
        setBoardProblem(p => p ? {...p, attempts:p.attempts+1, sends:p.sends+1, grade, notes} : p);
    } else {
      const existing = myProblems.find(p => p.id === problem.uuid);
      if (existing) {
        setMyProblems(prev => prev.map(p => p.id !== problem.uuid ? p :
          {...p, attempts:p.attempts+1, sends:p.sends+1, grade, notes}));
      } else {
        setMyProblems(prev => [{
          id:problem.uuid, name:problem.name, grade, angle:problem.angle,
          style:["Technical"], attempts:1, sends:1, liked:false, notes, holds:problem.holds,
        }, ...prev]);
      }
    }
    const today = new Date().toISOString().slice(0, 10);
    setSessions(prev => {
      const idx = prev.findIndex(s => s.date === today);
      if (idx >= 0) return prev.map((s,i) => i!==idx ? s : {...s, totalAttempts:(s.totalAttempts||0)+1, sends:(s.sends||0)+1});
      return [{ date:today, totalAttempts:1, sends:1, duration:0, feel:3, notes:"" }, ...prev];
    });
    showToast("SEND LOGGED ✓");
    setSendReview(null);
    setAttNote("");
  }

  function logAttempt(problem, sent) {
    if (!problem) return;
    if (sent) {
      // Intercept sends → open review modal
      setSendReview({ problem, grade: problem.grade || "V?", notes: "" });
      return;
    }
    // Attempts go straight through
    const isPersonal = !!problem.id && !problem.uuid;
    if (isPersonal) {
      setMyProblems(prev => prev.map(p => p.id !== problem.id ? p :
        {...p, attempts:p.attempts+1}));
      if (boardProblem?.id === problem.id)
        setBoardProblem(p => p ? {...p, attempts:p.attempts+1} : p);
    } else {
      const existing = myProblems.find(p => p.id === problem.uuid);
      if (existing) {
        setMyProblems(prev => prev.map(p => p.id !== problem.uuid ? p : {...p, attempts:p.attempts+1}));
      } else {
        setMyProblems(prev => [{
          id:problem.uuid, name:problem.name, grade:problem.grade,
          angle:problem.angle, style:["Technical"],
          attempts:1, sends:0, liked:false, notes:"", holds:problem.holds,
        }, ...prev]);
      }
    }
    const today = new Date().toISOString().slice(0, 10);
    setSessions(prev => {
      const idx = prev.findIndex(s => s.date === today);
      if (idx >= 0) return prev.map((s,i) => i!==idx ? s : {...s, totalAttempts:(s.totalAttempts||0)+1});
      return [{ date:today, totalAttempts:1, sends:0, duration:0, feel:3, notes:"" }, ...prev];
    });
    showToast("ATTEMPT LOGGED");
    setAttNote("");
  }

  function tapHold(holdId) {
    if (!boardProblem || !editMode) return;
    const update = prob => {
      const ex = prob.holds.find(h => h.id === holdId);
      if (ex) {
        if (ex.role === editRole) return {...prob, holds:prob.holds.filter(h => h.id !== holdId)};
        return {...prob, holds:prob.holds.map(h => h.id === holdId ? {...h, role:editRole} : h)};
      }
      return {...prob, holds:[...prob.holds, {id:holdId, role:editRole}]};
    };
    setBoardProblem(update);
    setMyProblems(prev => prev.map(p => p.id !== boardProblem.id ? p : update(p)));
  }

  const totalSends = myProblems.reduce((a,p) => a+p.sends,   0);
  const totalAtt   = myProblems.reduce((a,p) => a+p.attempts, 0);
  const sendRate   = totalAtt > 0 ? Math.round((totalSends/totalAtt)*100) : 0;

  const inp = {
    width:"100%", background:T.bg3, border:`1px solid ${T.border}`,
    color:T.text, borderRadius:4, padding:"8px 10px", fontSize:12,
    outline:"none", fontFamily:"'Geist',sans-serif", boxSizing:"border-box",
  };
  const card = (extra={}) => ({ background:T.bg2, border:`1px solid ${T.border}`, borderRadius:6, padding:"11px 13px", ...extra });
  const btnPri = { background:T.white, border:"none", color:T.bg, borderRadius:4, padding:"8px 13px", cursor:"pointer", fontSize:10, fontFamily:"'Geist Mono',monospace", fontWeight:700, textTransform:"uppercase", letterSpacing:"0.05em" };
  const btnSec = { background:T.bg3, border:`1px solid ${T.border}`, color:T.text2, borderRadius:4, padding:"8px 11px", cursor:"pointer", fontSize:10, fontFamily:"'Geist Mono',monospace", fontWeight:700, textTransform:"uppercase", letterSpacing:"0.05em" };

  function settingsButton() {
    return (
      <button onClick={()=>setSettingsOpen(true)} style={{
        width:"100%", background:T.bg2, border:`1px solid ${T.border}`,
        color:T.text2, borderRadius:6, padding:"12px 13px", cursor:"pointer",
        fontSize:12, fontFamily:"'Geist',sans-serif", fontWeight:600,
        display:"flex", alignItems:"center", justifyContent:"space-between",
        marginTop:4,
      }}>
        <span>Settings</span>
        <span style={{fontSize:14, color:T.text3}}>›</span>
      </button>
    );
  }

  return (
    <div style={{ height:"100svh", background:T.bg, color:T.text, fontFamily:"'Geist',sans-serif", display:"flex", flexDirection:"column", overflow:"hidden" }}>

      {splash && <SplashScreen onDone={() => setSplash(false)}/>}

      {/* HEADER */}
      <div style={{ position:"sticky", top:0, zIndex:50, background:T.bg+"f2", backdropFilter:"blur(16px)", borderBottom:`1px solid ${T.border}`, padding:"8px 14px" }}>
        <div style={{ display:"grid", gridTemplateColumns:"1fr auto 1fr", alignItems:"center" }}>
          {/* left spacer — mirrors right buttons width so logo stays centred */}
          <div/>
          {/* centre: logo + name */}
          <div style={{ display:"flex", alignItems:"center", gap:9, justifyContent:"center" }}>
            <Logo/>
            <div>
              <div style={{ fontFamily:"'Geist',sans-serif", fontWeight:700, fontSize:13, letterSpacing:"0.02em", textTransform:"uppercase", lineHeight:1, color:T.white }}>La<span style={{color:"#a855f7"}}>t</span>ched</div>
              <div style={{ marginTop:3 }}>
                <span style={{ fontSize:9, color:T.text3, fontFamily:"'Geist Mono',monospace", letterSpacing:"0.07em" }}>
                  {homeGym ? homeGym.name.toUpperCase() : "NO GYM"} · {angle}°
                </span>
              </div>
            </div>
          </div>
          {/* right: action buttons */}
          <div style={{ display:"flex", gap:5, justifyContent:"flex-end" }}>
            <button onClick={() => setCreateOpen(true)} style={{ background:"transparent", border:`1px solid ${T.border2}`, color:T.text2, borderRadius:4, padding:"5px 12px", fontSize:18, cursor:"pointer", lineHeight:1, fontWeight:300 }}>+</button>
            <button onClick={() => setLogOpen(true)} style={{ background:T.bg3, border:`1px solid ${T.border}`, color:T.text, borderRadius:4, padding:"5px 11px", fontSize:9, cursor:"pointer", fontFamily:"'Geist Mono',monospace", fontWeight:700, letterSpacing:"0.06em" }}>SESSION</button>
          </div>
        </div>
      </div>

      {/* NAV */}
      <div style={{ display:"flex", background:T.bg, borderBottom:`1px solid ${T.border}` }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            flex:1, background:"none", border:"none", color:tab===t?T.white:T.text3,
            padding:"8px 0", cursor:"pointer", fontSize:8,
            fontFamily:"'Geist Mono',monospace", fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase",
            borderBottom:`1px solid ${tab===t?T.purple:"transparent"}`, transition:"color 0.1s",
          }}>{t}</button>
        ))}
      </div>

      {/* CONTENT */}
      <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>

        {/* ══ MAP TAB ══ */}
        {tab === "Map" && (
          <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
            <GymMap homeGym={homeGym} onSetHomeGym={setHomeGym} onSeeGymClimbs={handleSeeGymClimbs}/>
          </div>
        )}

        {/* ══ CLIMBS TAB ══ */}
        {tab === "Climbs" && (
          <div style={{ flex:1, overflowY:"auto", padding:"14px 14px 20px", boxSizing:"border-box" }}>
            <div style={{ display:"flex", gap:3, marginBottom:10 }}>
              {[["community","COMMUNITY"],["mine","MY CLIMBS"]].map(([key,label]) => (
                <button key={key} onClick={() => setClimbSource(key)} style={{
                  flex:1, padding:"7px 0", borderRadius:4, cursor:"pointer",
                  background: climbSource===key ? T.bg3 : "transparent",
                  border:`1px solid ${climbSource===key ? T.border2 : T.border}`,
                  color: climbSource===key ? T.white : T.text3,
                  fontSize:9, fontFamily:"'Geist Mono',monospace", fontWeight:700, textTransform:"uppercase",
                  letterSpacing:"0.06em",
                }}>{label}</button>
              ))}
            </div>

            {/* Search row */}
            <div style={{display:"flex",gap:6,marginBottom:8}}>
              <input value={search} onChange={e=>setSearch(e.target.value)}
                placeholder="Search climbs…" style={{...inp,flex:1,marginBottom:0}}/>
              <button onClick={()=>setSetterOpen(true)} title="Search by setter" style={{
                ...(filterSetter?NOISE_BG:{background:T.bg3}), border:`1px solid ${filterSetter?T.purple:T.border}`,
                color:filterSetter?T.white:T.text2, borderRadius:R, padding:"0 12px",
                cursor:"pointer", fontSize:13, flexShrink:0,
              }}>👤</button>
              {climbSource==="community" && (() => {
                const anyFilter = gradeMin||gradeMax||filterAngle!==null||classicsOnly||filterSent||filterMinAscents||filterMinQuality||filterDateAfter||filterDateBefore||injuryLeft||injuryRight;
                return (
                  <button onClick={()=>setFilterOpen(true)} style={{
                    ...(anyFilter?NOISE_BG:{background:T.bg3}),
                    border:`1px solid ${anyFilter?T.purple:T.border}`,
                    color:anyFilter?T.white:T.text2,
                    borderRadius:R, padding:"0 12px", cursor:"pointer",
                    fontSize:9, fontFamily:"'Geist Mono',monospace", fontWeight:700, flexShrink:0,
                  }}>{anyFilter ? `FILTER ·${[gradeMin||gradeMax?` ${gradeMin||"V0"}–${gradeMax||"V15"}`:"", filterAngle!==null?` ${filterAngle}°`:"", filterSent?` ${filterSent}`:"", classicsOnly?" classic":""].filter(Boolean).join("")}` : "FILTER"}</button>
                );
              })()}
            </div>

            {/* Active filter chips */}
            {climbSource==="community" && (
              <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:8}}>
                {(gradeMin||gradeMax) && <span onClick={()=>{setGradeMin(null);setGradeMax(null);}} style={{fontSize:9,fontFamily:"'Geist Mono',monospace",background:T.purpleDim,border:`1px solid ${T.purpleBrd}`,color:T.purple,borderRadius:999,padding:"3px 8px",cursor:"pointer"}}>{gradeMin||"V0"}–{gradeMax||"V15"} ✕</span>}
                {filterAngle!==null && <span onClick={()=>setFilterAngle(null)} style={{fontSize:9,fontFamily:"'Geist Mono',monospace",background:T.purpleDim,border:`1px solid ${T.purpleBrd}`,color:T.purple,borderRadius:999,padding:"3px 8px",cursor:"pointer"}}>{filterAngle}° ✕</span>}
                {filterSent && <span onClick={()=>setFilterSent(null)} style={{fontSize:9,fontFamily:"'Geist Mono',monospace",background:T.purpleDim,border:`1px solid ${T.purpleBrd}`,color:T.purple,borderRadius:999,padding:"3px 8px",cursor:"pointer"}}>{filterSent} ✕</span>}
                {filterMinAscents && <span onClick={()=>setFilterMinAscents(null)} style={{fontSize:9,fontFamily:"'Geist Mono',monospace",background:T.purpleDim,border:`1px solid ${T.purpleBrd}`,color:T.purple,borderRadius:999,padding:"3px 8px",cursor:"pointer"}}>{filterMinAscents}+ ascents ✕</span>}
                {filterMinQuality && <span onClick={()=>setFilterMinQuality(null)} style={{fontSize:9,fontFamily:"'Geist Mono',monospace",background:T.purpleDim,border:`1px solid ${T.purpleBrd}`,color:T.purple,borderRadius:999,padding:"3px 8px",cursor:"pointer"}}>★{filterMinQuality}+ ✕</span>}
                {classicsOnly && <span onClick={()=>setClassicsOnly(false)} style={{fontSize:9,fontFamily:"'Geist Mono',monospace",background:T.purpleDim,border:`1px solid ${T.purpleBrd}`,color:T.purple,borderRadius:999,padding:"3px 8px",cursor:"pointer"}}>Classics ✕</span>}
                {filterSetter && <span onClick={()=>setFilterSetter(null)} style={{fontSize:9,fontFamily:"'Geist Mono',monospace",background:T.purpleDim,border:`1px solid ${T.purpleBrd}`,color:T.purple,borderRadius:999,padding:"3px 8px",cursor:"pointer"}}>@{filterSetter} ✕</span>}
                {filterDateAfter && <span onClick={()=>setFilterDateAfter("")} style={{fontSize:9,fontFamily:"'Geist Mono',monospace",background:T.purpleDim,border:`1px solid ${T.purpleBrd}`,color:T.purple,borderRadius:999,padding:"3px 8px",cursor:"pointer"}}>after {filterDateAfter} ✕</span>}
                {filterDateBefore && <span onClick={()=>setFilterDateBefore("")} style={{fontSize:9,fontFamily:"'Geist Mono',monospace",background:T.purpleDim,border:`1px solid ${T.purpleBrd}`,color:T.purple,borderRadius:999,padding:"3px 8px",cursor:"pointer"}}>before {filterDateBefore} ✕</span>}
                {sortBy!=="quality" && <span onClick={()=>setSortBy("quality")} style={{fontSize:9,fontFamily:"'Geist Mono',monospace",background:T.bg3,border:`1px solid ${T.border}`,color:T.text3,borderRadius:999,padding:"3px 8px",cursor:"pointer"}}>sort: {sortBy} ✕</span>}
                {injuryLeft  && <span onClick={()=>setInjuryLeft(false)}  style={{fontSize:9,fontFamily:"'Geist Mono',monospace",background:"rgba(255,60,60,0.12)",border:"1px solid rgba(255,60,60,0.4)",color:"#ff6060",borderRadius:999,padding:"3px 8px",cursor:"pointer"}}>✕ left hand injury</span>}
                {injuryRight && <span onClick={()=>setInjuryRight(false)} style={{fontSize:9,fontFamily:"'Geist Mono',monospace",background:"rgba(255,60,60,0.12)",border:"1px solid rgba(255,60,60,0.4)",color:"#ff6060",borderRadius:999,padding:"3px 8px",cursor:"pointer"}}>✕ right hand injury</span>}
              </div>
            )}

            {climbSource === "community" && (
              <>
                {climbsLoading ? (
                  <div style={{textAlign:"center",padding:"40px 0",color:T.text3,fontSize:11,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.1em"}}>
                    LOADING CLIMBS…
                  </div>
                ) : (
                <div style={{ fontSize:8, color:T.text3, fontFamily:"'Geist Mono',monospace", letterSpacing:"0.1em", marginBottom:8 }}>
                  {filteredCommunity.length.toLocaleString()} / {activeCommunityClimbs.length.toLocaleString()} CLIMBS
                </div>
                )}

                {!climbsLoading && filteredCommunity.slice(0, communityPage).map(climb => (
                  <div key={climb.uuid}
                    onClick={() => setSelectedClimb(selectedClimb?.uuid===climb.uuid ? null : climb)}
                    style={card({ marginBottom:6, cursor:"pointer",
                      borderLeft:`3px solid ${myClimbMap[climb.uuid]?.sends > 0 ? T.purple : T.border}`,
                      outline:selectedClimb?.uuid===climb.uuid?`1px solid ${T.border2}`:"none" })}>
                    {(() => { const tracked = myClimbMap[climb.uuid]; return (
                    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                      <div style={{ flex:1 }}>
                        <div style={{ display:"flex", alignItems:"center", gap:7, marginBottom:4, flexWrap:"wrap" }}>
                          <span style={{ fontFamily:"'Geist',sans-serif", fontWeight:700, fontSize:12 }}>{climb.name}</span>
                          <GradePill grade={climb.grade} small/>
                          {settings.showFeltGrade && feltGradeLog[climb.uuid] && (
                            <span style={{fontSize:8,fontFamily:"'Geist Mono',monospace",color:T.text3,letterSpacing:"0.04em"}}>consensus {feltGradeLog[climb.uuid]}</span>
                          )}
                          {tracked?.sends > 0 && <span style={{fontSize:8,fontFamily:"'Geist Mono',monospace",color:T.purple,background:T.purpleDim,border:`1px solid ${T.purpleBrd}`,borderRadius:999,padding:"1px 6px"}}>SENT {tracked.sends}✓</span>}
                          {tracked && !tracked.sends && <span style={{fontSize:8,fontFamily:"'Geist Mono',monospace",color:T.text3,background:T.bg3,border:`1px solid ${T.border}`,borderRadius:999,padding:"1px 6px"}}>{tracked.attempts} ATT</span>}
                          {betaLog[climb.uuid] && <span style={{fontSize:8,fontFamily:"'Geist Mono',monospace",color:"#3b82f6",background:"rgba(59,130,246,0.10)",border:"1px solid rgba(59,130,246,0.30)",borderRadius:999,padding:"1px 6px"}}>β BETA</span>}
                        </div>
                        <div style={{ fontSize:9, color:T.text3, fontFamily:"'Geist Mono',monospace", display:"flex", gap:10, alignItems:"center" }}>
                          <span>{climb.angle}°</span>
                          <button onClick={e=>{e.stopPropagation();setSetterProfile(climb.setter);}} style={{background:"none",border:"none",color:T.text2,cursor:"pointer",padding:0,fontFamily:"'Geist Mono',monospace",fontSize:9,textDecoration:"underline",textDecorationColor:T.text3,textUnderlineOffset:"3px"}}>@{climb.setter}</button>
                          <span style={{ marginLeft:"auto" }}>★{climb.quality.toFixed(1)} · {climb.ascents.toLocaleString()}</span>
                        </div>
                      </div>
                    </div>
                    );})()}
                    {selectedClimb?.uuid===climb.uuid && (
                      <div style={{ marginTop:12, paddingTop:12, borderTop:`1px solid ${T.border}` }}>
                        <Board problem={climb} placements={isMirror ? PLACEMENTS_MIRROR : PLACEMENTS} mirrorLayout={isMirror}/>
                        <div style={{ display:"flex", gap:6, marginTop:10 }}>
                          <button onClick={e=>{e.stopPropagation();setBoardProblem(climb);setBoardModalOpen(true);}}
                            style={{flex:1,background:T.bg3,border:`1px solid ${T.border}`,color:T.text,borderRadius:R,padding:"8px",cursor:"pointer",fontSize:10,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.08em"}}>
                            VIEW ON BOARD →
                          </button>
                          <button onClick={e=>{e.stopPropagation();logAttempt(climb,false)}} style={btnSec}>ATT</button>
                          <button onClick={e=>{e.stopPropagation();logAttempt(climb,true)}} style={btnPri}>SEND ✓</button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}

                {communityPage < filteredCommunity.length && (
                  <button onClick={() => setCommunityPage(p=>p+30)}
                    style={{width:"100%",background:T.bg2,border:`1px solid ${T.border}`,color:T.text2,borderRadius:R,padding:"10px",cursor:"pointer",fontSize:10,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.08em",marginTop:4}}>
                    LOAD MORE ({(filteredCommunity.length-communityPage).toLocaleString()} remaining)
                  </button>
                )}
              </>
            )}

            {climbSource === "mine" && (() => {
              const sq = search.toLowerCase();
              const trackedIds = new Set(myProblems.map(p => p.id));
              // Personal DB climbs not already tracked locally
              const dbMine = activePersonalClimbs.filter(c =>
                !trackedIds.has(c.uuid) &&
                (!sq || c.name.toLowerCase().includes(sq) || c.setter.toLowerCase().includes(sq))
              );
              const localMine = myProblems.filter(p =>
                !sq || p.name.toLowerCase().includes(sq)
              );
              const totalMine = localMine.length + dbMine.length;
              return totalMine === 0 ? (
                <div style={card({textAlign:"center",padding:"32px 16px"})}>
                  <div style={{fontSize:10,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.1em",marginBottom:8}}>NO PERSONAL CLIMBS YET</div>
                  <div style={{fontSize:12,color:T.text2,marginBottom:16}}>Set one with the + button or add your TB2 username to the extract script</div>
                  <button onClick={()=>setCreateOpen(true)} style={{...btnPri,...NOISE_BG,color:T.white}}>SET A CLIMB</button>
                </div>
              ) : (<>
              {dbMine.length > 0 && (
                <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.1em",marginBottom:8}}>
                  FROM TB2 · {dbMine.length} CLIMBS
                </div>
              )}
              {dbMine.map(c => (
                <div key={c.uuid}
                  onClick={()=>setSelectedClimb(selectedClimb?.uuid===c.uuid?null:c)}
                  style={card({marginBottom:6,cursor:"pointer",borderLeft:`3px solid ${T.purple}`})}>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <div style={{flex:1}}>
                      <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:4,flexWrap:"wrap"}}>
                        <span style={{fontFamily:"'Geist',sans-serif",fontWeight:700,fontSize:12}}>{c.name}</span>
                        <GradePill grade={c.grade} small/>
                        {settings.showFeltGrade && feltGradeLog[c.uuid] && (
                          <span style={{fontSize:8,fontFamily:"'Geist Mono',monospace",color:T.text3,letterSpacing:"0.04em"}}>consensus {feltGradeLog[c.uuid]}</span>
                        )}
                        <span style={{fontSize:8,color:T.purple,fontFamily:"'Geist Mono',monospace",border:`1px solid ${T.purpleBrd}`,borderRadius:999,padding:"1px 6px"}}>TB2</span>
                      </div>
                      <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",display:"flex",gap:10}}>
                        <span>{c.angle}°</span>
                        {c.ascents > 0 && <span>{c.ascents.toLocaleString()} ascents</span>}
                        {c.quality > 0 && <span style={{marginLeft:"auto"}}>★{c.quality.toFixed(1)}</span>}
                      </div>
                    </div>
                  </div>
                  {selectedClimb?.uuid===c.uuid && (
                    <div style={{marginTop:12,paddingTop:12,borderTop:`1px solid ${T.border}`}}>
                      <Board problem={c} placements={isMirror ? PLACEMENTS_MIRROR : PLACEMENTS} mirrorLayout={isMirror}/>
                      <div style={{display:"flex",gap:6,marginTop:10}}>
                        <button onClick={e=>{e.stopPropagation();setBoardProblem(c);setBoardModalOpen(true);}}
                          style={{flex:1,background:T.bg3,border:`1px solid ${T.border}`,color:T.text,borderRadius:R,padding:"8px",cursor:"pointer",fontSize:10,fontFamily:"'Geist Mono',monospace"}}>
                          VIEW ON BOARD →
                        </button>
                        <button onClick={e=>{e.stopPropagation();logAttempt(c,false)}} style={btnSec}>ATT</button>
                        <button onClick={e=>{e.stopPropagation();logAttempt(c,true)}} style={btnPri}>SEND ✓</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {localMine.length > 0 && dbMine.length > 0 && (
                <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.1em",margin:"12px 0 8px"}}>
                  SET LOCALLY · {localMine.length} CLIMBS
                </div>
              )}
              {localMine.map(p => (
                <div key={p.id}
                  onClick={()=>setSelectedClimb(selectedClimb?.id===p.id?null:p)}
                  style={card({marginBottom:6,cursor:"pointer",borderLeft:`3px solid ${p.sends>0?T.purple:T.border}`})}>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <div style={{flex:1}}>
                      <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:4}}>
                        <span style={{fontFamily:"'Geist',sans-serif",fontWeight:700,fontSize:12}}>{p.name}</span>
                        <GradePill grade={p.grade} sent={p.sends>0} small/>
                      </div>
                      <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",display:"flex",gap:10}}>
                        <span>{p.angle}°</span>
                        <span style={{marginLeft:"auto"}}>{p.attempts}att · {p.sends}✓</span>
                      </div>
                    </div>
                    <button onClick={e=>{e.stopPropagation();setMyProblems(prev=>prev.map(x=>x.id===p.id?{...x,liked:!x.liked}:x))}}
                      style={{background:"none",border:"none",cursor:"pointer",fontSize:14,color:p.liked?T.purple:T.text3,padding:0}}>
                      {p.liked?"★":"☆"}
                    </button>
                  </div>
                  {selectedClimb?.id===p.id && (
                    <div style={{marginTop:12,paddingTop:12,borderTop:`1px solid ${T.border}`}}>
                      <Board problem={p} placements={isMirror ? PLACEMENTS_MIRROR : PLACEMENTS} mirrorLayout={isMirror}/>
                      {p.notes && <div style={{fontSize:12,color:T.text2,margin:"10px 0",lineHeight:1.6}}>{p.notes}</div>}
                      <div style={{display:"flex",gap:6,marginTop:8}}>
                        <input value={attNote} onChange={e=>setAttNote(e.target.value)}
                          placeholder="Note…" onClick={e=>e.stopPropagation()} style={{...inp,flex:1}}/>
                        <button onClick={e=>{e.stopPropagation();logAttempt(p,false)}} style={btnSec}>ATT</button>
                        <button onClick={e=>{e.stopPropagation();logAttempt(p,true)}} style={btnPri}>SEND ✓</button>
                      </div>
                      <button onClick={e=>{e.stopPropagation();setBoardProblem(p);setBoardModalOpen(true);}}
                        style={{marginTop:8,width:"100%",background:"transparent",border:`1px solid ${T.border}`,color:T.text3,borderRadius:R,padding:"7px",cursor:"pointer",fontSize:10,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.08em"}}>
                        VIEW ON BOARD →
                      </button>
                    </div>
                  )}
                </div>
              ))}
              </>);
            })()}
          </div>
        )}

        {/* ══ PROFILE TAB ══ */}
        {tab === "Profile" && (
          <div style={{ flex:1, overflowY:"auto", padding:"14px 14px 20px", boxSizing:"border-box" }}>

            {/* ── User card ── */}
            <div style={{...card(), marginBottom:12, position:"relative"}}>
              <div style={{display:"flex",alignItems:"flex-start",gap:14}}>
                {/* Avatar */}
                <div style={{position:"relative",flexShrink:0}}>
                  {profile.avatarDataUrl ? (
                    <img src={profile.avatarDataUrl} alt="avatar" style={{
                      width:64, height:64, borderRadius:"50%", objectFit:"cover",
                      border:`2px solid ${T.border2}`, display:"block",
                    }}/>
                  ) : (
                    <div style={{
                      width:64, height:64, borderRadius:"50%", flexShrink:0,
                      background:`linear-gradient(135deg, #3a1a00, #7c3400)`,
                      border:`2px solid ${T.border2}`,
                      display:"flex", alignItems:"center", justifyContent:"center",
                      fontSize:26, fontFamily:"'Geist',sans-serif", fontWeight:800,
                      color:T.purple,
                    }}>
                      {(profile.username || "?").charAt(0).toUpperCase()}
                    </div>
                  )}
                </div>
                {/* Info */}
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontFamily:"'Geist',sans-serif",fontWeight:800,fontSize:16,color:T.white,lineHeight:1.2,marginBottom:4}}>
                    {profile.username || "Set your username"}
                  </div>
                  {homeGym && (
                    <div style={{fontSize:9,color:T.purple,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.08em",marginBottom:4}}>
                      {homeGym.name.toUpperCase()}
                    </div>
                  )}
                  {profile.bio ? (
                    <div style={{fontSize:12,color:T.text2,lineHeight:1.5}}>{profile.bio}</div>
                  ) : (
                    <div style={{fontSize:11,color:T.text3,fontStyle:"italic"}}>No bio yet</div>
                  )}
                </div>
                {/* Edit button */}
                <button onClick={()=>{setDraftProfile({...profile});setEditProfileOpen(true);}} style={{
                  background:T.bg3,border:`1px solid ${T.border}`,color:T.text2,
                  borderRadius:R,padding:"5px 11px",cursor:"pointer",
                  fontSize:9,fontFamily:"'Geist Mono',monospace",fontWeight:700,
                  flexShrink:0,
                }}>EDIT</button>
              </div>

              {/* Divider + stat row */}
              <div style={{borderTop:`1px solid ${T.border}`,marginTop:14,paddingTop:12,display:"flex",gap:0}}>
                {[["SENDS",totalSends],["ATTEMPTS",totalAtt],["CLIMBS",myProblems.length],["SESSIONS",sessions.length]].map(([l,v],i,arr) => (
                  <div key={l} style={{flex:1,textAlign:"center",borderRight:i<arr.length-1?`1px solid ${T.border}`:"none"}}>
                    <div style={{fontFamily:"'Geist',sans-serif",fontWeight:800,fontSize:20,color:T.white,lineHeight:1}}>{v}</div>
                    <div style={{fontSize:7,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.1em",marginTop:3}}>{l}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Send rate + followed setters row ── */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:14}}>
              <div style={card({textAlign:"center",padding:"12px 8px"})}>
                <div style={{fontFamily:"'Geist',sans-serif",fontWeight:800,fontSize:28,color:T.white,lineHeight:1}}>{sendRate}%</div>
                <div style={{fontSize:7,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.1em",marginTop:4}}>SEND RATE</div>
              </div>
              <div style={card({textAlign:"center",padding:"12px 8px"})}>
                <div style={{fontFamily:"'Geist',sans-serif",fontWeight:800,fontSize:28,color:T.white,lineHeight:1}}>
                  {followedSetters.size}
                </div>
                <div style={{fontSize:7,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.1em",marginTop:4}}>FOLLOWING</div>
              </div>
            </div>

            {/* ── Recent activity ── */}
            {(() => {
              const events = [];
              // Recent sends
              myProblems
                .filter(p => p.sends > 0)
                .slice(0, 5)
                .forEach(p => events.push({
                  icon:"✓", color:T.purple,
                  text:`Sent ${p.name} (${p.grade}) at ${p.angle}°`,
                  sub: p.attempts > 1 ? `${p.attempts} attempts` : "First try",
                }));
              // Recent sessions
              sessions.slice(0, 3).forEach(s => events.push({
                icon:"◎", color:T.text2,
                text:`Session · ${s.totalAttempts||0} att, ${s.sends||0} sends`,
                sub: s.date,
              }));
              // Followed setters
              if (followedSetters.size > 0) events.push({
                icon:"★", color:T.accentLight,
                text:`Following ${followedSetters.size} setter${followedSetters.size!==1?"s":""}`,
                sub: [...followedSetters].slice(0,3).map(s=>`@${s}`).join(", "),
              });
              if (events.length === 0) return (
                <>
                  <div style={card({textAlign:"center",padding:"24px 0",color:T.text3,fontSize:11,fontFamily:"'Geist Mono',monospace",marginBottom:12})}>
                    LOG SESSIONS AND SENDS TO SEE ACTIVITY
                  </div>
                  {settingsButton()}
                </>
              );
              return (
                <>
                  <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.12em",marginBottom:10}}>RECENT ACTIVITY</div>
                  {events.map((e,i) => (
                    <div key={i} style={{...card(),marginBottom:6,display:"flex",gap:12,alignItems:"flex-start"}}>
                      <div style={{
                        width:32, height:32, borderRadius:"50%", background:T.bg3, border:`1px solid ${T.border}`,
                        display:"flex", alignItems:"center", justifyContent:"center",
                        fontSize:12, color:e.color, flexShrink:0, fontWeight:700,
                      }}>{e.icon}</div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:12,color:T.text,lineHeight:1.5}}>{e.text}</div>
                        <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",marginTop:2}}>{e.sub}</div>
                      </div>
                    </div>
                  ))}
                  {settingsButton()}
                </>
              );
            })()}
          </div>
        )}

        {/* ══ STATS TAB (includes sessions) ══ */}
        {tab === "Stats" && (
          <div style={{ flex:1, overflowY:"auto", padding:"14px 14px 20px", boxSizing:"border-box" }}>
            {/* Today's live session */}
            {(() => {
              const today = new Date().toISOString().slice(0,10);
              const todaySess = sessions.find(s => s.date === today);
              if (!todaySess) return null;
              return (
                <div style={{...card({marginBottom:14}), borderLeft:`3px solid ${T.purple}`}}>
                  <div style={{fontSize:9,color:T.purple,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.12em",marginBottom:8}}>TODAY</div>
                  <div style={{display:"flex",gap:16}}>
                    <div>
                      <div style={{fontFamily:"'Geist',sans-serif",fontWeight:800,fontSize:28,color:T.white,lineHeight:1}}>{todaySess.totalAttempts||0}</div>
                      <div style={{fontSize:8,color:T.text3,fontFamily:"'Geist Mono',monospace",marginTop:3}}>ATTEMPTS</div>
                    </div>
                    <div>
                      <div style={{fontFamily:"'Geist',sans-serif",fontWeight:800,fontSize:28,color:T.purple,lineHeight:1}}>{todaySess.sends||0}</div>
                      <div style={{fontSize:8,color:T.text3,fontFamily:"'Geist Mono',monospace",marginTop:3}}>SENDS</div>
                    </div>
                  </div>
                </div>
              );
            })()}
            {/* Stat tiles */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:14}}>
              {[["SENDS",totalSends],["ATTEMPTS",totalAtt],["SEND RATE",sendRate+"%"],["MY CLIMBS",myProblems.length]].map(([l,v]) => (
                <div key={l} style={card({textAlign:"center"})}>
                  <div style={{fontFamily:"'Geist',sans-serif",fontWeight:800,fontSize:30,color:T.white,lineHeight:1}}>{v}</div>
                  <div style={{fontSize:8,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.12em",marginTop:4}}>{l}</div>
                </div>
              ))}
            </div>

            {/* Grade pyramid */}
            {myProblems.length > 0 && (
              <div style={card({marginBottom:12})}>
                <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.12em",marginBottom:12}}>SEND PYRAMID</div>
                {GRADES.map(g => {
                  const sent = myProblems.filter(p=>p.grade===g&&p.sends>0).length;
                  const tot  = myProblems.filter(p=>p.grade===g).length;
                  if (!tot) return null;
                  return (
                    <div key={g} style={{display:"flex",alignItems:"center",gap:8,marginBottom:7}}>
                      <span style={{width:26,fontSize:10,fontFamily:"'Geist Mono',monospace",fontWeight:700,color:sent>0?T.white:T.text3}}>{g}</span>
                      <div style={{flex:1,background:T.bg3,borderRadius:2,height:5,overflow:"hidden"}}>
                        <div style={{width:`${(sent/tot)*100}%`,height:"100%",background:sent>0?T.purple:T.border,borderRadius:2}}/>
                      </div>
                      <span style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",width:28,textAlign:"right"}}>{sent}/{tot}</span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Projects */}
            {myProblems.filter(p=>p.sends===0&&p.attempts>0).length > 0 && (
              <div style={card({marginBottom:12})}>
                <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.12em",marginBottom:10}}>PROJECTS</div>
                {myProblems.filter(p=>p.sends===0&&p.attempts>0).sort((a,b)=>b.attempts-a.attempts).map(p => (
                  <div key={p.id} style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                    <GradePill grade={p.grade} small/>
                    <span style={{flex:1,fontSize:12,fontFamily:"'Geist',sans-serif",fontWeight:700}}>{p.name}</span>
                    <span style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace"}}>{p.attempts}att</span>
                  </div>
                ))}
              </div>
            )}

            {/* Sessions */}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.12em"}}>SESSION LOG</div>
              <button onClick={()=>setLogOpen(true)} style={{background:T.white,border:"none",color:T.bg,borderRadius:R,padding:"4px 10px",cursor:"pointer",fontSize:9,fontFamily:"'Geist',sans-serif",fontWeight:800,textTransform:"uppercase"}}>+ LOG</button>
            </div>
            {sessions.length === 0 ? (
              <div style={card({textAlign:"center",padding:"20px"})}>
                <div style={{fontSize:11,color:T.text3,fontFamily:"'Geist Mono',monospace"}}>No sessions yet</div>
              </div>
            ) : sessions.map((s,i) => (
              <div key={i} style={card({marginBottom:8})}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                  <span style={{fontFamily:"'Geist',sans-serif",fontWeight:800,fontSize:13}}>{s.date}</span>
                  <Feel val={s.feel}/>
                </div>
                <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.08em",marginBottom:s.notes?5:0}}>
                  {s.duration}MIN · {s.totalAttempts}ATT · {s.sends}SENDS
                </div>
                {s.notes && <div style={{fontSize:12,color:T.text2}}>{s.notes}</div>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── LOG SESSION MODAL ── */}
      {logOpen && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",zIndex:100,display:"flex",alignItems:"flex-end"}}
          onClick={()=>setLogOpen(false)}>
          <div onClick={e=>e.stopPropagation()} style={{background:T.bg2,borderRadius:`${R*2}px ${R*2}px 0 0`,border:`1px solid ${T.border}`,borderBottom:"none",padding:"20px 16px 36px",width:"100%",boxSizing:"border-box"}}>
            <div style={{fontFamily:"'Geist',sans-serif",fontWeight:800,fontSize:16,textTransform:"uppercase",marginBottom:16}}>LOG SESSION</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
              <div>
                <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.1em",marginBottom:4}}>DATE</div>
                <input type="date" value={newSess.date} onChange={e=>setNewSess(s=>({...s,date:e.target.value}))} style={inp}/>
              </div>
              <div>
                <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.1em",marginBottom:4}}>DURATION (MIN)</div>
                <input type="number" value={newSess.duration} onChange={e=>setNewSess(s=>({...s,duration:Number(e.target.value)}))} style={inp}/>
              </div>
            </div>
            <div style={{marginBottom:12}}>
              <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.1em",marginBottom:6}}>FEEL</div>
              <Feel val={newSess.feel} onClick={n=>setNewSess(s=>({...s,feel:n}))}/>
            </div>
            <textarea value={newSess.notes} onChange={e=>setNewSess(s=>({...s,notes:e.target.value}))}
              placeholder="Session notes…" rows={2} style={{...inp,marginBottom:14,resize:"none"}}/>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>setLogOpen(false)} style={{flex:1,background:T.bg3,border:`1px solid ${T.border}`,color:T.text,borderRadius:R,padding:"11px",cursor:"pointer",fontSize:11,fontFamily:"'Geist Mono',monospace"}}>CANCEL</button>
              <button onClick={()=>{setSessions(p=>[{...newSess,totalAttempts:0,sends:0},...p]);setLogOpen(false);}}
                style={{flex:2,...btnPri,padding:"11px",fontSize:12}}>SAVE SESSION</button>
            </div>
          </div>
        </div>
      )}

      {/* ── CREATE CLIMB — board-first full-screen ── */}
      {createOpen && draftClimb && (
        <div style={{position:"fixed",inset:0,background:T.bg,zIndex:300,display:"flex",flexDirection:"column"}}>
          {/* Header */}
          <div style={{padding:"11px 14px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",gap:10,background:T.bg2,flexShrink:0}}>
            <button onClick={()=>setCreateOpen(false)} style={{background:"none",border:"none",color:T.text2,fontSize:22,lineHeight:1,cursor:"pointer",padding:"0 2px"}}>←</button>
            <div style={{flex:1,fontFamily:"'Geist',sans-serif",fontWeight:800,fontSize:13,textTransform:"uppercase",letterSpacing:"0.01em"}}>Set a Climb</div>
            <button onClick={()=>{
              if (!draftClimb.name.trim()) return;
              const p = {...draftClimb, id:`my-${Date.now()}`, name:draftClimb.name.trim(), style:[draftClimb.style], attempts:0, sends:0, liked:false};
              setMyProblems(prev=>[p,...prev]);
              setCreateOpen(false);
            }} style={{...NOISE_BG,border:"none",color:T.white,borderRadius:R,padding:"6px 14px",fontSize:10,cursor:"pointer",fontFamily:"'Geist',sans-serif",fontWeight:800,opacity:draftClimb.name.trim()?1:0.35}}>
              SAVE
            </button>
          </div>

          {/* Scrollable body */}
          <div style={{flex:1,overflowY:"auto",padding:"14px 14px 48px"}}>

            {/* ① Board — first thing */}
            <Board problem={draftClimb} editMode={true} editRole={draftRole} onHoldTap={tapDraftHold} placements={isMirror ? PLACEMENTS_MIRROR : PLACEMENTS} mirrorLayout={isMirror}/>

            {/* Role selector */}
            <div style={{display:"flex",gap:5,margin:"10px 0 18px"}}>
              {ROLES.map(role => (
                <button key={role} onClick={()=>setDraftRole(role)} style={{
                  flex:1, padding:"7px 0", fontSize:9, borderRadius:R, cursor:"pointer",
                  fontFamily:"'Geist Mono',monospace", fontWeight:700, textTransform:"uppercase",
                  background:draftRole===role ? ROLE_COLOR[role]+"28" : T.bg3,
                  border:`1px solid ${draftRole===role ? ROLE_COLOR[role] : T.border}`,
                  color:draftRole===role ? ROLE_COLOR[role] : T.text3,
                }}>{role}</button>
              ))}
            </div>

            {/* Divider */}
            <div style={{borderTop:`1px solid ${T.border}`,margin:"4px 0 18px"}}/>

            {/* ② Name */}
            <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.12em",marginBottom:5}}>NAME</div>
            <input value={draftClimb.name} onChange={e=>setDraftClimb(c=>({...c,name:e.target.value}))}
              placeholder="What do you call it?" style={{...inp,marginBottom:16,fontSize:14}}/>

            {/* ③ Angle */}
            <div style={{...card(), marginBottom:16}}><AngleSel value={draftClimb.angle} onChange={v=>setDraftClimb(c=>({...c,angle:v}))}/></div>

            {/* ④ Grade */}
            <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.12em",marginBottom:6}}>GRADE</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:16}}>
              {GRADES.map(g => (
                <button key={g} onClick={()=>setDraftClimb(c=>({...c,grade:g}))} style={{
                  padding:"5px 11px", borderRadius:R, fontSize:10, cursor:"pointer",
                  fontFamily:"'Geist Mono',monospace", fontWeight:700,
                  ...(draftClimb.grade===g?NOISE_BG:{background:T.bg3}),
                  border:`1px solid ${draftClimb.grade===g?T.purple:T.border}`,
                  color:draftClimb.grade===g?T.white:T.text3,
                }}>{g}</button>
              ))}
            </div>

            {/* ⑤ Description */}
            <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.12em",marginBottom:5}}>DESCRIPTION</div>
            <textarea value={draftClimb.notes} onChange={e=>setDraftClimb(c=>({...c,notes:e.target.value}))}
              placeholder="Beta, key positions, sequences…" rows={3} style={{...inp,marginBottom:16,resize:"none"}}/>

            {/* ⑥ Match */}
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:T.bg2,border:`1px solid ${T.border}`,borderRadius:R,padding:"12px 14px"}}>
              <div>
                <div style={{fontSize:12,color:T.text,marginBottom:2}}>Match finish</div>
                <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace"}}>Both hands allowed on top hold</div>
              </div>
              <button onClick={()=>setDraftClimb(c=>({...c,match:!c.match}))} style={{
                width:42, height:22, borderRadius:999, border:"none", cursor:"pointer",
                ...(draftClimb.match?NOISE_BG:{background:T.bg3}),
                position:"relative", flexShrink:0,
              }}>
                <div style={{
                  width:16, height:16, background:T.white, borderRadius:"50%",
                  position:"absolute", top:3, transition:"left 0.18s",
                  left:draftClimb.match ? 23 : 3,
                }}/>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── BOARD MODAL ── */}
      {boardModalOpen && (
        <div style={{position:"fixed",inset:0,background:T.bg,zIndex:300,display:"flex",flexDirection:"column",overflow:"hidden"}}>
          {/* Modal header */}
          <div style={{padding:"12px 14px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",gap:10,background:T.bg2,flexShrink:0}}>
            <button onClick={()=>{setBoardModalOpen(false);setEditMode(false);setView3d(false);}} style={{background:"none",border:"none",color:T.text2,fontSize:22,cursor:"pointer",padding:"0 4px",lineHeight:1}}>←</button>
            <div style={{flex:1}}>
              {boardProblem ? (
                <>
                  <div style={{fontFamily:"'Geist',sans-serif",fontWeight:800,fontSize:13,textTransform:"uppercase"}}>{boardProblem.name}</div>
                  <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",marginTop:1,display:"flex",gap:5,alignItems:"center"}}>
                    <span>{boardProblem.grade}{settings.showFeltGrade && feltGradeLog[boardProblem?.uuid] ? ` → consensus ${feltGradeLog[boardProblem.uuid]}` : ""} · {boardProblem.angle}°</span>
                    {boardProblem.setter && (
                      <button onClick={()=>setSetterProfile(boardProblem.setter)} style={{background:"none",border:"none",color:T.text2,cursor:"pointer",padding:0,fontFamily:"'Geist Mono',monospace",fontSize:9,textDecoration:"underline",textDecorationColor:T.text3,textUnderlineOffset:"3px"}}>
                        @{boardProblem.setter}
                      </button>
                    )}
                  </div>
                </>
              ) : <div style={{fontFamily:"'Geist',sans-serif",fontWeight:800,fontSize:13}}>BOARD</div>}
            </div>
            {boardProblem && !boardProblem.uuid && !view3d && (
              <button onClick={()=>setEditMode(v=>!v)} style={{
                ...(editMode?NOISE_BG:{background:T.bg3}), border:`1px solid ${editMode?T.purple:T.border}`,
                color:editMode?T.white:T.text2, borderRadius:R, padding:"5px 11px",
                fontSize:9, cursor:"pointer", fontFamily:"'Geist Mono',monospace", fontWeight:700,
              }}>{editMode?"DONE":"EDIT"}</button>
            )}
          </div>

          {/* View tab bar */}
          <div style={{display:"flex",background:T.bg2,borderBottom:`1px solid ${T.border}`,flexShrink:0}}>
            <button
              onClick={()=>{ setView3d(false); setEditMode(false); }}
              style={{
                flex:1, padding:"13px 0", background:"none", border:"none",
                borderBottom: !view3d ? `2px solid ${T.text}` : "2px solid transparent",
                color: !view3d ? T.text : T.text3,
                fontFamily:"'Geist Mono',monospace", fontSize:11, fontWeight:700,
                letterSpacing:"0.10em", cursor:"pointer", transition:"color .12s",
              }}
            >BOARD</button>
            <button
              onClick={()=>setView3d(true)}
              style={{
                flex:1, padding:"13px 0", background:"none", border:"none",
                borderBottom: view3d ? `2px solid ${T.purple}` : "2px solid transparent",
                color: view3d ? T.purple : T.text3,
                fontFamily:"'Geist Mono',monospace", fontSize:11, fontWeight:700,
                letterSpacing:"0.10em", cursor:"pointer", transition:"color .12s",
              }}
            >3D VIEW</button>
          </div>

          {/* Board */}
          {view3d ? (
            <div style={{flex:1,position:"relative"}}>
              <Suspense fallback={
                <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",
                  background:"#090909",color:T.text3,fontFamily:"'Geist Mono',monospace",fontSize:10,letterSpacing:"0.1em"}}>
                  LOADING 3D…
                </div>
              }>
                <Board3D
                  problem={boardProblem}
                  placements={isMirror ? PLACEMENTS_MIRROR : PLACEMENTS}
                  mirror={isMirror}
                  angle={boardProblem?.angle ?? angle}
                  problems={filteredCommunity}
                  onNavigate={setBoardProblem}
                />
              </Suspense>
            </div>
          ) : (
          <div style={{flex:1,overflowY:"auto",padding:"14px"}}>
            <Board problem={boardProblem} editMode={editMode} editRole={editRole} onHoldTap={tapHold}
              placements={isMirror ? PLACEMENTS_MIRROR : PLACEMENTS} mirrorLayout={isMirror}
              betaMode={betaMode} betaAssignments={betaDraft} onBetaHoldTap={tapBetaHold}/>

            {editMode && (
              <div style={{marginTop:10}}>
                <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.1em",marginBottom:6}}>TAP HOLDS TO ASSIGN ROLE</div>
                <div style={{display:"flex",gap:5}}>
                  {ROLES.map(role => (
                    <button key={role} onClick={()=>setEditRole(role)} style={{
                      flex:1,padding:"7px 0",fontSize:9,borderRadius:R,cursor:"pointer",
                      fontFamily:"'Geist Mono',monospace",fontWeight:700,textTransform:"uppercase",
                      background:editRole===role?ROLE_COLOR[role]+"22":T.bg3,
                      border:`1px solid ${editRole===role?ROLE_COLOR[role]:T.border}`,
                      color:editRole===role?ROLE_COLOR[role]:T.text3,
                    }}>{role}</button>
                  ))}
                </div>
              </div>
            )}

            {!editMode && boardProblem && !betaMode && (
              <>
                <div style={{display:"flex",gap:6,marginTop:12}}>
                  <input value={attNote} onChange={e=>setAttNote(e.target.value)} placeholder="Note…" style={{...inp,flex:1}}/>
                  <button onClick={()=>logAttempt(boardProblem,false)} style={btnSec}>ATT</button>
                  <button onClick={()=>logAttempt(boardProblem,true)} style={btnPri}>SEND ✓</button>
                </div>
                {/* Consensus grade row */}
                {boardProblem.uuid && (
                  <div style={{marginTop:8}}>
                    <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.1em",marginBottom:5}}>
                      CONSENSUS GRADE{feltGradeLog[boardProblem.uuid] && <span style={{color:T.text2,marginLeft:5}}>· {feltGradeLog[boardProblem.uuid]} <span onClick={()=>clearFeltGrade(boardProblem.uuid)} style={{cursor:"pointer",opacity:0.6}}>✕</span></span>}
                    </div>
                    <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                      {GRADES.filter(g => {
                        const si = GRADES.indexOf(boardProblem.grade);
                        const gi = GRADES.indexOf(g);
                        return gi >= Math.max(0, si - 2) && gi <= Math.min(GRADES.length - 1, si + 3);
                      }).map(g => (
                        <button key={g} onClick={() => feltGradeLog[boardProblem.uuid] === g ? clearFeltGrade(boardProblem.uuid) : saveFeltGrade(boardProblem.uuid, g)} style={{
                          padding:"5px 9px", borderRadius:R, cursor:"pointer",
                          fontFamily:"'Geist Mono',monospace", fontWeight:700, fontSize:9,
                          background: feltGradeLog[boardProblem.uuid] === g ? T.purpleDim : T.bg3,
                          border: `1px solid ${feltGradeLog[boardProblem.uuid] === g ? T.purpleBrd : T.border}`,
                          color: feltGradeLog[boardProblem.uuid] === g ? T.purple : T.text3,
                        }}>{g}{g === boardProblem.grade ? " ·" : ""}</button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Beta logging row */}
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginTop:8}}>
                  <button onClick={()=>startBeta(boardProblem)} style={{
                    background:"none", border:`1px solid ${T.border}`, color:T.text3,
                    borderRadius:R, padding:"5px 10px", cursor:"pointer",
                    fontSize:9, fontFamily:"'Geist Mono',monospace", fontWeight:700,
                  }}>
                    {betaLog[boardProblem.uuid] ? "✎ EDIT BETA" : "+ LOG BETA"}
                  </button>
                  {betaLog[boardProblem.uuid] && (
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      {["left","right","match"].map(a => {
                        const count = Object.values(betaLog[boardProblem.uuid].holdAssignments||{}).filter(v=>v===a).length;
                        if (!count) return null;
                        return <span key={a} style={{fontSize:8,fontFamily:"'Geist Mono',monospace",color:BETA_COLORS[a]}}>{count}{a[0].toUpperCase()}</span>;
                      })}
                      <button onClick={()=>clearBeta(boardProblem.uuid)} style={{background:"none",border:"none",color:T.text3,cursor:"pointer",fontSize:8,fontFamily:"'Geist Mono',monospace",padding:"0 2px"}}>✕</button>
                    </div>
                  )}
                </div>
              </>
            )}

            {/* Beta logging mode UI */}
            {!editMode && boardProblem && betaMode && (
              <div style={{marginTop:12}}>
                <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.1em",marginBottom:8}}>
                  TAP HOLDS TO ASSIGN — FOOT HOLDS IGNORED
                </div>
                {/* Hand selector */}
                <div style={{display:"flex",gap:6,marginBottom:8}}>
                  {[["left","L HAND"],["right","R HAND"],["match","MATCH"]].map(([hand,label])=>(
                    <button key={hand} onClick={()=>setBetaHand(hand)} style={{
                      flex:1, padding:"9px 0", borderRadius:R, cursor:"pointer",
                      fontFamily:"'Geist Mono',monospace", fontWeight:700, fontSize:9,
                      background: betaHand===hand ? BETA_COLORS[hand]+"22" : T.bg3,
                      border: `1px solid ${betaHand===hand ? BETA_COLORS[hand] : T.border}`,
                      color: betaHand===hand ? BETA_COLORS[hand] : T.text3,
                    }}>{label}</button>
                  ))}
                </div>
                <div style={{fontSize:8,color:T.text3,fontFamily:"'Geist Mono',monospace",marginBottom:10}}>
                  Tap again to clear · {Object.keys(betaDraft).length} holds assigned
                </div>
                <div style={{display:"flex",gap:6}}>
                  <button onClick={()=>{setBetaMode(false);setBetaDraft({});}} style={{...btnSec,flex:1}}>CANCEL</button>
                  <button onClick={saveBeta} style={{...btnPri,flex:2}}>SAVE BETA ✓</button>
                </div>
              </div>
            )}
          </div>
          )}
        </div>
      )}

      {/* ── FILTER MODAL ── */}
      {filterOpen && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.82)",zIndex:400,display:"flex",alignItems:"flex-end"}}
          onClick={()=>setFilterOpen(false)}>
          <div onClick={e=>e.stopPropagation()} style={{
            background:T.bg2, borderRadius:`${R*2}px ${R*2}px 0 0`,
            border:`1px solid ${T.border}`, borderBottom:"none",
            width:"100%", boxSizing:"border-box", maxHeight:"92vh",
            display:"flex", flexDirection:"column",
          }}>
            {/* Header */}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"18px 16px 14px",borderBottom:`1px solid ${T.border}`,flexShrink:0}}>
              <div style={{fontFamily:"'Geist',sans-serif",fontWeight:800,fontSize:16}}>FILTER CLIMBS</div>
              <button onClick={()=>{
                setGradeMin(null);setGradeMax(null);setFilterAngle(null);setClassicsOnly(false);
                setFilterSent(null);setFilterMinAscents(null);setFilterMinQuality(null);
                setFilterDateAfter("");setFilterDateBefore("");setSortBy("quality");
                setInjuryLeft(false);setInjuryRight(false);
              }} style={{background:"none",border:`1px solid ${T.border}`,color:T.text3,borderRadius:R,padding:"4px 10px",cursor:"pointer",fontSize:9,fontFamily:"'Geist Mono',monospace"}}>
                CLEAR ALL
              </button>
            </div>

            <div style={{overflowY:"auto",flex:1,padding:"16px 16px 8px"}}>

              {/* SORT */}
              <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.12em",marginBottom:7}}>SORT BY</div>
              <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:20}}>
                {[["quality","★ Quality"],["ascents","Popularity"],["difficulty","Hardest"],["grade","Grade"],["date","Newest"]].map(([v,l])=>(
                  <button key={v} onClick={()=>setSortBy(v)} style={{
                    padding:"6px 11px",borderRadius:R,fontSize:10,cursor:"pointer",
                    fontFamily:"'Geist Mono',monospace",fontWeight:700,
                    background:sortBy===v?T.white:T.bg3,
                    border:`1px solid ${sortBy===v?T.white:T.border}`,
                    color:sortBy===v?T.bg:T.text3,
                  }}>{l}</button>
                ))}
              </div>

              {/* GRADE RANGE — single row, two-tap selection */}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:7}}>
                <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.12em"}}>GRADE RANGE</div>
                <div style={{fontSize:9,fontFamily:"'Geist Mono',monospace",color:T.text2}}>
                  <span style={{color:T.purple,fontWeight:700}}>{gradeMin||"V0"}</span>
                  <span style={{color:T.text3}}> → </span>
                  <span style={{color:T.accentLight,fontWeight:700}}>{gradeMax||"V15"}</span>
                </div>
              </div>
              <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:4}}>
                {GRADES.map(g => {
                  const gi = GRADES.indexOf(g);
                  const minI = gradeMin ? GRADES.indexOf(gradeMin) : -1;
                  const maxI = gradeMax ? GRADES.indexOf(gradeMax) : -1;
                  const isMin = g === gradeMin;
                  const isMax = g === gradeMax;
                  const inRange = minI >= 0 && maxI >= 0 && gi > minI && gi < maxI;
                  return (
                    <button key={g} onClick={()=>handleGradeTap(g)} style={{
                      padding:"6px 10px", borderRadius:R, fontSize:9, cursor:"pointer",
                      fontFamily:"'Geist Mono',monospace", fontWeight:700,
                      ...(isMin || isMax ? NOISE_BG : {background: inRange ? "rgba(168,85,247,0.18)" : T.bg3}),
                      border:`1px solid ${isMin ? T.purple : isMax ? T.accentLight : inRange ? T.purpleBrd : T.border}`,
                      color: isMin || isMax ? T.white : inRange ? T.accentLight : T.text3,
                    }}>{g}</button>
                  );
                })}
              </div>
              <div style={{fontSize:8,color:T.text3,fontFamily:"'Geist Mono',monospace",marginBottom:20}}>
                Tap to set start · tap again to set end
              </div>

              {/* ANGLE */}
              <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.12em",marginBottom:7}}>ANGLE</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:20}}>
                {ALL_ANGLES.map(a=>(
                  <button key={a} onClick={()=>setFilterAngle(filterAngle===a?null:a)} style={{
                    padding:"6px 10px",borderRadius:R,fontSize:9,cursor:"pointer",
                    fontFamily:"'Geist Mono',monospace",fontWeight:700,
                    ...(filterAngle===a?NOISE_BG:{background:T.bg3}),
                    border:`1px solid ${filterAngle===a?T.purple:T.border}`,
                    color:filterAngle===a?T.white:T.text3,
                  }}>{a}°</button>
                ))}
              </div>

              {/* STATUS */}
              <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.12em",marginBottom:7}}>MY STATUS</div>
              <div style={{display:"flex",gap:4,marginBottom:20}}>
                {[[null,"All"],["not-sent","Not Sent"],["sent","Sent ✓"],["project","Project"]].map(([v,l])=>(
                  <button key={String(v)} onClick={()=>setFilterSent(filterSent===v?null:v)} style={{
                    flex:1,padding:"7px 4px",borderRadius:R,fontSize:9,cursor:"pointer",
                    fontFamily:"'Geist Mono',monospace",fontWeight:700,textAlign:"center",
                    ...(filterSent===v?NOISE_BG:{background:T.bg3}),
                    border:`1px solid ${filterSent===v?T.purple:T.border}`,
                    color:filterSent===v?T.white:T.text3,
                  }}>{l}</button>
                ))}
              </div>

              {/* QUALITY + ASCENTS */}
              <div style={{display:"flex",gap:12,marginBottom:20}}>
                <div style={{flex:1}}>
                  <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.12em",marginBottom:7}}>MIN QUALITY</div>
                  <div style={{display:"flex",gap:3}}>
                    {[1,1.5,2,2.5,3].map(q=>(
                      <button key={q} onClick={()=>setFilterMinQuality(filterMinQuality===q?null:q)} style={{
                        flex:1,padding:"6px 0",borderRadius:R,fontSize:9,cursor:"pointer",
                        fontFamily:"'Geist Mono',monospace",fontWeight:700,
                        ...(filterMinQuality===q?NOISE_BG:{background:T.bg3}),
                        border:`1px solid ${filterMinQuality===q?T.purple:T.border}`,
                        color:filterMinQuality===q?T.white:T.text3,
                      }}>★{q}</button>
                    ))}
                  </div>
                </div>
                <div style={{flex:1}}>
                  <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.12em",marginBottom:7}}>MIN ASCENTS</div>
                  <div style={{display:"flex",gap:3}}>
                    {[[null,"Any"],[10,"10+"],[50,"50+"],[200,"200+"],[500,"500+"]].map(([v,l])=>(
                      <button key={String(v)} onClick={()=>setFilterMinAscents(filterMinAscents===v?null:v)} style={{
                        flex:1,padding:"6px 0",borderRadius:R,fontSize:8,cursor:"pointer",
                        fontFamily:"'Geist Mono',monospace",fontWeight:700,
                        ...(filterMinAscents===v?NOISE_BG:{background:T.bg3}),
                        border:`1px solid ${filterMinAscents===v?T.purple:T.border}`,
                        color:filterMinAscents===v?T.white:T.text3,
                      }}>{l}</button>
                    ))}
                  </div>
                </div>
              </div>

              {/* DATE SET */}
              <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.12em",marginBottom:7}}>DATE SET</div>
              <div style={{display:"flex",gap:10,marginBottom:20}}>
                <div style={{flex:1}}>
                  <div style={{fontSize:8,color:T.text3,fontFamily:"'Geist Mono',monospace",marginBottom:4}}>AFTER</div>
                  <input type="date" value={filterDateAfter} onChange={e=>setFilterDateAfter(e.target.value)}
                    style={{...inp,fontSize:11,padding:"7px 10px"}}/>
                </div>
                <div style={{flex:1}}>
                  <div style={{fontSize:8,color:T.text3,fontFamily:"'Geist Mono',monospace",marginBottom:4}}>BEFORE</div>
                  <input type="date" value={filterDateBefore} onChange={e=>setFilterDateBefore(e.target.value)}
                    style={{...inp,fontSize:11,padding:"7px 10px"}}/>
                </div>
              </div>

              {/* INJURY FILTER */}
              <div style={{marginBottom:20}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:4}}>
                  <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.12em"}}>INJURY FILTER</div>
                  {(injuryLeft||injuryRight) && (
                    <button onClick={()=>{setInjuryLeft(false);setInjuryRight(false);}} style={{background:"none",border:"none",color:"#ff6060",cursor:"pointer",fontSize:8,fontFamily:"'Geist Mono',monospace",padding:0}}>CLEAR</button>
                  )}
                </div>
                <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",marginBottom:10}}>
                  Hide climbs that load an injured hand
                </div>

                {/* Visual board split — tap a side to mark it injured */}
                <div style={{display:"flex",gap:8,marginBottom:8}}>
                  {[["left","L",injuryLeft,setInjuryLeft],["right","R",injuryRight,setInjuryRight]].map(([side,label,active,setter])=>(
                    <button key={side} onClick={()=>setter(v=>!v)} style={{
                      flex:1, padding:"16px 0 12px", borderRadius:R, cursor:"pointer",
                      background: active ? "rgba(255,60,60,0.10)" : T.bg3,
                      border: `1px solid ${active ? "#ff4444" : T.border}`,
                      display:"flex", flexDirection:"column", alignItems:"center", gap:6,
                      transition:"all 0.15s",
                    }}>
                      {/* hand SVG */}
                      <svg width="28" height="28" viewBox="0 0 28 28" fill="none"
                        style={{transform: side==="right" ? "scaleX(-1)" : "none"}}>
                        <path d="M8 22V10a2 2 0 0 1 4 0v5" stroke={active?"#ff4444":T.text3} strokeWidth="1.6" strokeLinecap="round"/>
                        <path d="M12 15V8a2 2 0 0 1 4 0v7" stroke={active?"#ff4444":T.text3} strokeWidth="1.6" strokeLinecap="round"/>
                        <path d="M16 15V9a2 2 0 0 1 4 0v6" stroke={active?"#ff4444":T.text3} strokeWidth="1.6" strokeLinecap="round"/>
                        <path d="M20 15v-3a2 2 0 0 1 4 0v5c0 4-2.5 7-7 7H14c-2.5 0-4.5-1-6-3l-2-3a1.8 1.8 0 0 1 2.8-2.2L10 18V10" stroke={active?"#ff4444":T.text3} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      <div style={{fontSize:9,fontFamily:"'Geist Mono',monospace",fontWeight:700,
                        color:active?"#ff4444":T.text3,letterSpacing:"0.08em"}}>
                        {label === "L" ? "LEFT" : "RIGHT"} HAND
                      </div>
                      <div style={{fontSize:8,fontFamily:"'Geist Mono',monospace",
                        color:active?"#ff6060":"transparent",letterSpacing:"0.06em"}}>
                        ● INJURED
                      </div>
                    </button>
                  ))}
                </div>
                <div style={{fontSize:8,color:T.text3,fontFamily:"'Geist Mono',monospace",lineHeight:1.5}}>
                  Checks start, hand & finish holds only · foot holds ignored
                </div>
              </div>

              {/* CLASSICS */}
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:T.bg3,border:`1px solid ${T.border}`,borderRadius:R,padding:"13px 14px",marginBottom:8}}>
                <div>
                  <div style={{fontSize:13,color:T.text,marginBottom:2}}>Classics only</div>
                  <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace"}}>Quality ≥ 3.0 · 200+ ascents</div>
                </div>
                <button onClick={()=>setClassicsOnly(v=>!v)} style={{
                  width:44,height:23,borderRadius:999,border:"none",cursor:"pointer",flexShrink:0,
                  ...(classicsOnly?NOISE_BG:{background:T.bg4}),position:"relative",
                }}>
                  <div style={{width:17,height:17,background:T.white,borderRadius:"50%",position:"absolute",top:3,transition:"left 0.18s",left:classicsOnly?24:3}}/>
                </button>
              </div>

            </div>

            <div style={{padding:"12px 16px 36px",borderTop:`1px solid ${T.border}`,flexShrink:0}}>
              <button onClick={()=>setFilterOpen(false)} style={{
                width:"100%",...NOISE_BG,border:"none",color:T.white,
                borderRadius:R,padding:"13px",cursor:"pointer",
                fontSize:12,fontFamily:"'Geist',sans-serif",fontWeight:800,textTransform:"uppercase",
              }}>SHOW {filteredCommunity.length.toLocaleString()} CLIMBS</button>
            </div>
          </div>
        </div>
      )}

      {/* ── SETTER SEARCH MODAL ── */}
      {setterOpen && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",zIndex:400,display:"flex",alignItems:"flex-end"}}
          onClick={()=>setSetterOpen(false)}>
          <div onClick={e=>e.stopPropagation()} style={{
            background:T.bg2,borderRadius:`${R*2}px ${R*2}px 0 0`,
            border:`1px solid ${T.border}`,borderBottom:"none",
            padding:"20px 16px 40px",width:"100%",boxSizing:"border-box",maxHeight:"80vh",display:"flex",flexDirection:"column",
          }}>
            <div style={{fontFamily:"'Geist',sans-serif",fontWeight:800,fontSize:16,textTransform:"uppercase",marginBottom:12}}>Find a Setter</div>
            <input value={setterSearch} onChange={e=>setSetterSearch(e.target.value)}
              placeholder="Search setters…" autoFocus style={{...inp,marginBottom:10,flexShrink:0}}/>
            {filterSetter && (
              <button onClick={()=>{setFilterSetter(null);setSetterOpen(false);}} style={{
                background:T.purpleDim,border:`1px solid ${T.purpleBrd}`,color:T.purple,
                borderRadius:R,padding:"8px",cursor:"pointer",marginBottom:8,flexShrink:0,
                fontSize:9,fontFamily:"'Geist Mono',monospace",fontWeight:700,
              }}>CLEAR — @{filterSetter}</button>
            )}
            <div style={{overflowY:"auto",flex:1,gap:5,display:"flex",flexDirection:"column"}}>
              {setterList
                .filter(s => !setterSearch || s.name.toLowerCase().includes(setterSearch.toLowerCase()))
                .slice(0,100)
                .map(s => (
                <button key={s.name}
                  onClick={()=>{setFilterSetter(s.name===filterSetter?null:s.name);setSetterOpen(false);setSetterSearch("");}}
                  style={{
                    background:filterSetter===s.name?T.purpleDim:T.bg3,
                    border:`1px solid ${filterSetter===s.name?T.purpleBrd:T.border}`,
                    color:filterSetter===s.name?T.purple:T.text,
                    borderRadius:R,padding:"10px 13px",cursor:"pointer",flexShrink:0,
                    display:"flex",justifyContent:"space-between",alignItems:"center",textAlign:"left",
                  }}>
                  <span style={{fontFamily:"'Geist',sans-serif",fontWeight:600,fontSize:13}}>@{s.name}</span>
                  <span style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace"}}>{s.count} climbs</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* SEND REVIEW MODAL */}
      {sendReview && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",zIndex:500,display:"flex",alignItems:"flex-end"}}
          onClick={()=>setSendReview(null)}>
          <div onClick={e=>e.stopPropagation()} style={{
            background:T.bg2, borderRadius:`${R*2}px ${R*2}px 0 0`,
            border:`1px solid ${T.border}`, borderBottom:"none",
            padding:"24px 16px 40px", width:"100%", boxSizing:"border-box",
          }}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20}}>
              <div style={{flex:1}}>
                <div style={{fontSize:9,color:T.purple,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.12em",marginBottom:3}}>SEND LOGGED ✓</div>
                <div style={{fontFamily:"'Geist',sans-serif",fontWeight:800,fontSize:18}}>{sendReview.problem.name}</div>
              </div>
              <button onClick={()=>setSendReview(null)} style={{background:"none",border:"none",color:T.text3,fontSize:22,cursor:"pointer",lineHeight:1}}>✕</button>
            </div>

            <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.1em",marginBottom:8}}>YOUR GRADE</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:20}}>
              {GRADES.map(g => (
                <button key={g} onClick={()=>setSendReview(r=>({...r,grade:g}))} style={{
                  padding:"7px 12px", borderRadius:R, cursor:"pointer", fontSize:12,
                  fontFamily:"'Geist Mono',monospace", fontWeight:700,
                  ...(sendReview.grade===g ? NOISE_BG : {background:T.bg3}),
                  border:`1px solid ${sendReview.grade===g ? T.purple : T.border}`,
                  color:sendReview.grade===g ? T.white : T.text,
                }}>{g}</button>
              ))}
            </div>

            <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.1em",marginBottom:8}}>NOTES</div>
            <textarea
              value={sendReview.notes}
              onChange={e=>setSendReview(r=>({...r,notes:e.target.value}))}
              placeholder="How'd it feel? Key moves, conditions, beta…"
              rows={3}
              style={{...inp, resize:"none", marginBottom:16}}
            />

            <button
              onClick={()=>commitSend(sendReview.problem, sendReview.grade, sendReview.notes)}
              style={{...btnPri, width:"100%", padding:"13px", fontSize:13}}>
              SAVE SEND
            </button>
          </div>
        </div>
      )}

      {/* ── SETTINGS MODAL ── */}
      {settingsOpen && (
        <div style={{position:"fixed",inset:0,background:T.bg,zIndex:700,display:"flex",flexDirection:"column",overflow:"hidden"}}>
          <div style={{padding:"12px 14px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",gap:10,background:T.bg2,flexShrink:0}}>
            <button onClick={()=>setSettingsOpen(false)} style={{background:"none",border:"none",color:T.text2,fontSize:22,cursor:"pointer",padding:"0 4px",lineHeight:1}}>←</button>
            <div style={{fontFamily:"'Geist',sans-serif",fontWeight:800,fontSize:13,textTransform:"uppercase"}}>Settings</div>
          </div>
          <div style={{flex:1,overflowY:"auto",padding:"20px 14px"}}>
            <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.12em",marginBottom:10}}>GRADES</div>
            <div style={card({marginBottom:8})}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
                <div>
                  <div style={{fontSize:13,color:T.text,fontWeight:600,marginBottom:3}}>Consensus Grade</div>
                  <div style={{fontSize:10,color:T.text3,fontFamily:"'Geist Mono',monospace",lineHeight:1.5}}>Show community consensus grade alongside the setter grade on climb cards</div>
                </div>
                <button onClick={()=>updateSetting("showFeltGrade", !settings.showFeltGrade)} style={{
                  width:46, height:26, borderRadius:999, border:"none", cursor:"pointer",
                  background: settings.showFeltGrade ? T.purple : T.bg3,
                  position:"relative", flexShrink:0,
                  transition:"background 0.2s",
                }}>
                  <div style={{
                    width:18, height:18, background:T.white, borderRadius:"50%",
                    position:"absolute", top:4, transition:"left 0.2s",
                    left: settings.showFeltGrade ? 24 : 4,
                    boxShadow:"0 1px 3px rgba(0,0,0,0.4)",
                  }}/>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── EDIT PROFILE MODAL ── */}
      {editProfileOpen && draftProfile && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.82)",zIndex:700,display:"flex",alignItems:"flex-end"}}
          onClick={()=>setEditProfileOpen(false)}>
          <div onClick={e=>e.stopPropagation()} style={{
            background:T.bg2, borderRadius:`${R*2}px ${R*2}px 0 0`,
            border:`1px solid ${T.border}`, borderBottom:"none",
            padding:"22px 16px 44px", width:"100%", boxSizing:"border-box",
          }}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
              <div style={{fontFamily:"'Geist',sans-serif",fontWeight:800,fontSize:16}}>EDIT PROFILE</div>
              <button onClick={()=>setEditProfileOpen(false)} style={{background:"none",border:"none",color:T.text3,fontSize:20,cursor:"pointer",lineHeight:1}}>✕</button>
            </div>

            {/* Avatar picker */}
            <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:20}}>
              {draftProfile.avatarDataUrl ? (
                <img src={draftProfile.avatarDataUrl} alt="" style={{width:60,height:60,borderRadius:"50%",objectFit:"cover",border:`2px solid ${T.border2}`}}/>
              ) : (
                <div style={{width:60,height:60,borderRadius:"50%",background:`linear-gradient(135deg,#3a1a00,#7c3400)`,border:`2px solid ${T.border2}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,fontWeight:800,color:T.purple}}>
                  {(draftProfile.username||"?").charAt(0).toUpperCase()}
                </div>
              )}
              <div>
                <label style={{display:"block",background:T.bg3,border:`1px solid ${T.border}`,color:T.text2,borderRadius:R,padding:"7px 14px",cursor:"pointer",fontSize:9,fontFamily:"'Geist Mono',monospace",fontWeight:700,textTransform:"uppercase"}}>
                  UPLOAD PHOTO
                  <input type="file" accept="image/*" style={{display:"none"}} onChange={e=>{
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = ev => setDraftProfile(p=>({...p, avatarDataUrl: ev.target.result}));
                    reader.readAsDataURL(file);
                  }}/>
                </label>
                {draftProfile.avatarDataUrl && (
                  <button onClick={()=>setDraftProfile(p=>({...p,avatarDataUrl:""}))} style={{background:"none",border:"none",color:T.text3,cursor:"pointer",fontSize:9,fontFamily:"'Geist Mono',monospace",marginTop:6,padding:0}}>
                    REMOVE PHOTO
                  </button>
                )}
              </div>
            </div>

            {/* Username */}
            <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.1em",marginBottom:5}}>USERNAME</div>
            <input value={draftProfile.username} onChange={e=>setDraftProfile(p=>({...p,username:e.target.value}))}
              placeholder="Your name or handle" style={{...inp,marginBottom:14,fontSize:14}}/>

            {/* Bio */}
            <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.1em",marginBottom:5}}>BIO</div>
            <textarea value={draftProfile.bio} onChange={e=>setDraftProfile(p=>({...p,bio:e.target.value}))}
              placeholder="What do you climb? Where? Why?" rows={3}
              style={{...inp,resize:"none",marginBottom:18}}/>

            <button onClick={()=>{saveProfile(draftProfile);setEditProfileOpen(false);}}
              style={{width:"100%",...NOISE_BG,border:"none",color:T.white,borderRadius:R,padding:"13px",cursor:"pointer",fontSize:12,fontFamily:"'Geist',sans-serif",fontWeight:800}}>
              SAVE PROFILE
            </button>
          </div>
        </div>
      )}

      {/* ── SETTER PROFILE PANEL ── */}
      {setterProfile && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.82)",zIndex:600,display:"flex",alignItems:"flex-end"}}
          onClick={()=>setSetterProfile(null)}>
          <div onClick={e=>e.stopPropagation()} style={{
            background:T.bg2, borderRadius:`${R*2}px ${R*2}px 0 0`,
            border:`1px solid ${T.border}`, borderBottom:"none",
            width:"100%", maxHeight:"86vh", display:"flex", flexDirection:"column",
            boxSizing:"border-box", position:"relative",
          }}>
            {/* Close */}
            <button onClick={()=>setSetterProfile(null)} style={{position:"absolute",top:14,right:14,background:"none",border:"none",color:T.text3,fontSize:20,cursor:"pointer",lineHeight:1,padding:4,zIndex:1}}>✕</button>

            {/* Header */}
            <div style={{padding:"18px 16px 14px",borderBottom:`1px solid ${T.border}`,flexShrink:0}}>
              <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:14}}>
                <SetterAvatar username={setterProfile} size={46}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontFamily:"'Geist',sans-serif",fontWeight:800,fontSize:16}}>@{setterProfile}</div>
                  <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.06em",marginTop:3}}>
                    {setterClimbs.length} CLIMBS
                    {setterClimbs.length > 0 && ` · ★${(setterClimbs.reduce((a,c)=>a+c.quality,0)/setterClimbs.length).toFixed(2)} AVG`}
                  </div>
                </div>
                <button onClick={()=>toggleFollow(setterProfile)} style={{
                  borderRadius:R, padding:"7px 14px", fontSize:9, cursor:"pointer",
                  fontFamily:"'Geist',sans-serif", fontWeight:800, textTransform:"uppercase",
                  flexShrink:0,
                  ...(followedSetters.has(setterProfile)
                    ? {...NOISE_BG, border:`1px solid ${T.purple}`, color:T.white}
                    : {background:T.bg3, border:`1px solid ${T.border}`, color:T.text2}),
                }}>
                  {followedSetters.has(setterProfile) ? "FOLLOWING ✓" : "+ FOLLOW"}
                </button>
              </div>

              {/* Grade histogram */}
              {setterClimbs.length > 0 && (() => {
                const dist = {};
                setterClimbs.forEach(c => { dist[c.grade] = (dist[c.grade]||0)+1; });
                const max = Math.max(...Object.values(dist));
                const activeGrades = GRADES.filter(g => dist[g]);
                return (
                  <div style={{display:"flex",gap:2,alignItems:"flex-end",height:32}}>
                    {activeGrades.map(g => (
                      <div key={g} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2,flex:1,minWidth:0}}>
                        <div style={{width:"100%",background:T.purple,borderRadius:"2px 2px 0 0",
                          height:Math.max(3,Math.round((dist[g]/max)*22)),opacity:0.72}}/>
                        <div style={{fontSize:6,color:T.text3,fontFamily:"'Geist Mono',monospace",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"clip"}}>{g}</div>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>

            {/* Climb list */}
            <div style={{overflowY:"auto",flex:1,padding:"10px 16px 40px"}}>
              {setterClimbs.length === 0 ? (
                <div style={{textAlign:"center",padding:"40px 0",color:T.text3,fontSize:11,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.1em"}}>
                  NO CLIMBS IN LOADED DATA
                </div>
              ) : setterClimbs.map(c => {
                const tracked = myClimbMap[c.uuid];
                return (
                  <div key={c.uuid}
                    onClick={()=>{setSelectedClimb(c);setSetterProfile(null);setTab("Climbs");setClimbSource("community");}}
                    style={{...card({marginBottom:6,cursor:"pointer"}),
                      borderLeft:`3px solid ${tracked?.sends>0?T.purple:T.border}`}}>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <div style={{flex:1}}>
                        <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:4,flexWrap:"wrap"}}>
                          <span style={{fontFamily:"'Geist',sans-serif",fontWeight:700,fontSize:12}}>{c.name}</span>
                          <GradePill grade={c.grade} small/>
                          {tracked?.sends>0 && <span style={{fontSize:8,fontFamily:"'Geist Mono',monospace",color:T.purple,background:T.purpleDim,border:`1px solid ${T.purpleBrd}`,borderRadius:999,padding:"1px 6px"}}>SENT {tracked.sends}✓</span>}
                        </div>
                        <div style={{fontSize:9,color:T.text3,fontFamily:"'Geist Mono',monospace",display:"flex",gap:10}}>
                          <span>{c.angle}°</span>
                          <span style={{marginLeft:"auto"}}>★{c.quality.toFixed(1)} · {c.ascents.toLocaleString()}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* TOAST */}
      {toast && (
        <div style={{
          position:"fixed", bottom:32, left:"50%", transform:"translateX(-50%)",
          background:T.white, color:T.bg, borderRadius:R, padding:"10px 18px",
          fontSize:11, fontFamily:"'Geist Mono',monospace", fontWeight:700,
          letterSpacing:"0.08em", zIndex:9999, pointerEvents:"none",
          boxShadow:"0 4px 24px rgba(0,0,0,0.4)",
        }}>{toast}</div>
      )}
    </div>
  );
}
