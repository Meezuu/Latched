import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useTexture, Grid } from "@react-three/drei";
import { Component, useRef, useMemo, useEffect, useState, Suspense } from "react";
import * as THREE from "three";

// ─── Constants ────────────────────────────────────────────────────────────────
const ROLE_COLOR          = { start:"#22c55e", hand:"#3b82f6", finish:"#ef4444", foot:"#a855f7" };
const ROLE_COLOR_FALLBACK = "#3b82f6";
const BOARD_ANGLES = [20, 25, 30, 35, 40, 45, 50, 55];
const BW      = 8;
const BH      = BW * (1144 / 1080);
const KICK_H  = 1.1;
const KICK_D  = 0.50;
const FRAME_D = 0.30;
const FLOOR_Y = -(BH / 2) - KICK_H;

// Camera
const CAM_POLAR     = Math.PI * 0.530;   // angle from zenith — slightly above horizontal
const CAM_LOOKAT    = new THREE.Vector3(0, 0.5, 0);
const CAM_RADIUS_MIN = 5;
const CAM_RADIUS_MAX = 26;
const CAM_RADIUS_DEF = 20;
const AZ_DEFAULT    = 30;               // degrees — gives instant 3-D sense on load
const AZ_MIN        = -85;
const AZ_MAX        =  85;
const PAN_MIN       = -4.0;
const PAN_MAX       =  8.0;
const ROT_SCALE     = 0.10;             // deg per screen pixel (touch)
const ROT_SCALE_MS  = 0.12;            // deg per screen pixel (mouse)
const PAN_SCALE     = 0.016;           // world-units per screen pixel

// ─── Preload textures at module init so first render has no flash ─────────────
useTexture.preload("/tb2-plastic.png");
useTexture.preload("/tb2-wood.png");

// ─── Coordinate helpers ───────────────────────────────────────────────────────
function toWorld(normX, normY, mirror) {
  const x = mirror ? (1 - normX / 100) * BW - BW / 2 : (normX / 100) * BW - BW / 2;
  const y = -(normY / 100) * BH + BH / 2;
  return [x, y];
}

function frand(seed, salt = 0) {
  const x = Math.sin(seed * 127.1 + salt * 311.7 + 91.3) * 43758.5453;
  return x - Math.floor(x);
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// ─── Matrix helper ────────────────────────────────────────────────────────────
const _m4  = new THREE.Matrix4();
const _v3  = new THREE.Vector3();
const _q   = new THREE.Quaternion();
const _eul = new THREE.Euler();
const _s3  = new THREE.Vector3();

function applyMatrix(mesh, i, x, y, z, sx, sy, sz, rz) {
  _v3.set(x, y, z);
  _eul.set(0, 0, rz);
  _q.setFromEuler(_eul);
  _s3.set(sx, sy, sz);
  _m4.compose(_v3, _q, _s3);
  mesh.setMatrixAt(i, _m4);
}

// ─── Module-level geometries ──────────────────────────────────────────────────
const DOME_GEO = new THREE.SphereGeometry(1, 14, 9, 0, Math.PI * 2, 0, Math.PI * 0.55);
DOME_GEO.rotateX(-Math.PI / 2);

const BLOCK_GEO = new THREE.CylinderGeometry(0.55, 0.68, 0.60, 6);
BLOCK_GEO.rotateX(-Math.PI / 2);

const FOOT_GEO = new THREE.CylinderGeometry(1, 0.86, 0.16, 8);
FOOT_GEO.rotateX(-Math.PI / 2);

const RING_GEO        = new THREE.RingGeometry(0.22, 0.28, 36);
const RING_GLOW_PLANE = new THREE.PlaneGeometry(1, 1);

const GLOW_TEX = (() => {
  const S = 256, half = S / 2;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(half, half, half * 0.08, half, half, half);
  g.addColorStop(0,    "rgba(255,255,255,0)");
  g.addColorStop(0.24, "rgba(255,255,255,0)");
  g.addColorStop(0.32, "rgba(255,255,255,0.80)");
  g.addColorStop(0.38, "rgba(255,255,255,1)");
  g.addColorStop(0.46, "rgba(255,255,255,0.60)");
  g.addColorStop(0.60, "rgba(255,255,255,0.20)");
  g.addColorStop(0.78, "rgba(255,255,255,0.05)");
  g.addColorStop(1.0,  "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(canvas);
})();

// ─── Hold classification ───────────────────────────────────────────────────────
function holdArchetype(id, defaultRole) {
  if (defaultRole === "foot") return "foot";
  return frand(id, 5) < 0.28 ? "block" : "dome";
}

// ─── Shared update helper ─────────────────────────────────────────────────────
function flushInstances(mesh, list, writeFn) {
  if (!mesh) return;
  mesh.count = list.length;
  const col = new THREE.Color();
  list.forEach((entry, i) => writeFn(mesh, i, col, entry));
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

// ─── InactiveHoldBumps ────────────────────────────────────────────────────────
function InactiveHoldBumps({ placements, activeMap, mirror }) {
  const entries   = useMemo(() => Object.entries(placements ?? {}), [placements]);
  const hasActive = Object.keys(activeMap).length > 0;

  const maxCounts = useMemo(() => {
    const c = { dome: 0, block: 0, foot: 0 };
    entries.forEach(([pid, p]) => { c[holdArchetype(Number(pid), p.default_role)]++; });
    return c;
  }, [entries]);

  const byArch = useMemo(() => {
    const dome = [], block = [], foot = [];
    entries.forEach(([pid, p]) => {
      const id = Number(pid);
      if (activeMap[id]) return;
      const arch = holdArchetype(id, p.default_role);
      if (arch === "dome")       dome.push([pid, p]);
      else if (arch === "block") block.push([pid, p]);
      else                       foot.push([pid, p]);
    });
    return { dome, block, foot };
  }, [entries, activeMap]);

  const domeRef  = useRef();
  const blockRef = useRef();
  const footRef  = useRef();

  const holdColor = hasActive ? "#1e1810" : "#a08860";

  useEffect(() => {
    flushInstances(domeRef.current, byArch.dome, (mesh, i, col, [pid, p]) => {
      const id = Number(pid);
      const [x, y] = toWorld(p.x, p.y, mirror);
      const rz = frand(id, 1) * Math.PI * 2;
      const r  = 0.088 + frand(id, 2) * 0.072;
      applyMatrix(mesh, i, x, y, 0.007, r, r * 0.44, r, rz);
      col.set(holdColor);
      mesh.setColorAt(i, col);
    });
  }, [byArch.dome, hasActive, mirror]);

  useEffect(() => {
    flushInstances(blockRef.current, byArch.block, (mesh, i, col, [pid, p]) => {
      const id = Number(pid);
      const [x, y] = toWorld(p.x, p.y, mirror);
      const rz = frand(id, 1) * Math.PI * 2;
      const r  = 0.082 + frand(id, 2) * 0.046;
      applyMatrix(mesh, i, x, y, 0.006, r, r * 0.88, r * 0.54, rz);
      col.set(holdColor);
      mesh.setColorAt(i, col);
    });
  }, [byArch.block, hasActive, mirror]);

  useEffect(() => {
    flushInstances(footRef.current, byArch.foot, (mesh, i, col, [pid, p]) => {
      const id = Number(pid);
      const [x, y] = toWorld(p.x, p.y, mirror);
      const rz = frand(id, 1) * Math.PI * 2;
      const r  = 0.058 + frand(id, 2) * 0.022;
      applyMatrix(mesh, i, x, y, 0.003, r * 0.78, r * 0.62, r * 0.14, rz);
      col.set(holdColor);
      mesh.setColorAt(i, col);
    });
  }, [byArch.foot, hasActive, mirror]);

  if (!entries.length) return null;

  const opacity = hasActive ? 0.45 : 0.80;
  return (
    <>
      {maxCounts.dome > 0 && (
        <instancedMesh ref={domeRef} args={[DOME_GEO, undefined, maxCounts.dome]} renderOrder={3}>
          <meshStandardMaterial roughness={1.0} metalness={0} transparent opacity={opacity}
            emissive={holdColor} emissiveIntensity={0.55} />
        </instancedMesh>
      )}
      {maxCounts.block > 0 && (
        <instancedMesh ref={blockRef} args={[BLOCK_GEO, undefined, maxCounts.block]} renderOrder={3}>
          <meshStandardMaterial roughness={1.0} metalness={0} transparent opacity={opacity}
            emissive={holdColor} emissiveIntensity={0.55} />
        </instancedMesh>
      )}
      {maxCounts.foot > 0 && (
        <instancedMesh ref={footRef} args={[FOOT_GEO, undefined, maxCounts.foot]} renderOrder={3}>
          <meshStandardMaterial roughness={1.0} metalness={0} transparent opacity={hasActive ? 0.40 : 0.75}
            emissive={holdColor} emissiveIntensity={0.55} />
        </instancedMesh>
      )}
    </>
  );
}

// ─── ActiveHoldBodies ─────────────────────────────────────────────────────────
function ActiveHoldBodies({ placements, activeMap, mirror }) {
  const entries = useMemo(() => Object.entries(placements ?? {}), [placements]);

  const maxCounts = useMemo(() => {
    const c = { dome: 0, block: 0, foot: 0 };
    entries.forEach(([pid, p]) => { c[holdArchetype(Number(pid), p.default_role)]++; });
    return c;
  }, [entries]);

  const byArch = useMemo(() => {
    const dome = [], block = [], foot = [];
    entries.forEach(([pid, p]) => {
      const id   = Number(pid);
      const role = activeMap[id];
      if (!role) return;
      const arch = holdArchetype(id, p.default_role);
      if (arch === "dome")       dome.push([pid, p, role]);
      else if (arch === "block") block.push([pid, p, role]);
      else                       foot.push([pid, p, role]);
    });
    return { dome, block, foot };
  }, [entries, activeMap]);

  const domeRef  = useRef();
  const blockRef = useRef();
  const footRef  = useRef();

  useEffect(() => {
    flushInstances(domeRef.current, byArch.dome, (mesh, i, col, [pid, p, role]) => {
      const id = Number(pid);
      const [x, y] = toWorld(p.x, p.y, mirror);
      const rz = frand(id, 1) * Math.PI * 2;
      const r  = 0.128 + frand(id, 2) * 0.058;
      applyMatrix(mesh, i, x, y, 0.030, r, r * 0.64, r, rz);
      col.set(ROLE_COLOR[role] ?? ROLE_COLOR_FALLBACK).multiplyScalar(4.0);
      mesh.setColorAt(i, col);
    });
  }, [byArch.dome, activeMap, mirror]);

  useEffect(() => {
    flushInstances(blockRef.current, byArch.block, (mesh, i, col, [pid, p, role]) => {
      const id = Number(pid);
      const [x, y] = toWorld(p.x, p.y, mirror);
      const rz = frand(id, 1) * Math.PI * 2;
      const r  = 0.118 + frand(id, 2) * 0.048;
      applyMatrix(mesh, i, x, y, 0.028, r, r * 0.88, r * 0.56, rz);
      col.set(ROLE_COLOR[role] ?? ROLE_COLOR_FALLBACK).multiplyScalar(4.0);
      mesh.setColorAt(i, col);
    });
  }, [byArch.block, activeMap, mirror]);

  useEffect(() => {
    flushInstances(footRef.current, byArch.foot, (mesh, i, col, [pid, p, role]) => {
      const id = Number(pid);
      const [x, y] = toWorld(p.x, p.y, mirror);
      const rz = frand(id, 1) * Math.PI * 2;
      const r  = 0.080 + frand(id, 2) * 0.028;
      applyMatrix(mesh, i, x, y, 0.016, r * 0.78, r * 0.62, r * 0.16, rz);
      col.set(ROLE_COLOR[role] ?? ROLE_COLOR_FALLBACK).multiplyScalar(4.0);
      mesh.setColorAt(i, col);
    });
  }, [byArch.foot, activeMap, mirror]);

  if (!entries.length) return null;

  return (
    <>
      {maxCounts.dome > 0 && (
        <instancedMesh ref={domeRef} args={[DOME_GEO, undefined, maxCounts.dome]} renderOrder={4}>
          <meshStandardMaterial roughness={0.70} metalness={0} />
        </instancedMesh>
      )}
      {maxCounts.block > 0 && (
        <instancedMesh ref={blockRef} args={[BLOCK_GEO, undefined, maxCounts.block]} renderOrder={4}>
          <meshStandardMaterial roughness={0.70} metalness={0} />
        </instancedMesh>
      )}
      {maxCounts.foot > 0 && (
        <instancedMesh ref={footRef} args={[FOOT_GEO, undefined, maxCounts.foot]} renderOrder={4}>
          <meshStandardMaterial roughness={0.75} metalness={0} />
        </instancedMesh>
      )}
    </>
  );
}

// ─── ActiveRings ──────────────────────────────────────────────────────────────
function ActiveRings({ placements, activeMap, mirror }) {
  const ringRef    = useRef();
  const glowRef    = useRef();
  const glowMatRef = useRef();
  const entries = useMemo(() => Object.entries(placements ?? {}), [placements]);
  const active  = useMemo(
    () => entries.filter(([pid]) => activeMap[Number(pid)]),
    [entries, activeMap],
  );

  useEffect(() => {
    const ring = ringRef.current;
    const glow = glowRef.current;
    if (!ring || !glow) return;
    ring.count = glow.count = active.length;
    const col = new THREE.Color();
    active.forEach(([pid, p], i) => {
      const [x, y]    = toWorld(p.x, p.y, mirror);
      const roleColor = ROLE_COLOR[activeMap[Number(pid)]] ?? ROLE_COLOR_FALLBACK;
      applyMatrix(glow, i, x, y, 0.010, 1.5, 1.5, 1, 0);
      col.set(roleColor);
      glow.setColorAt(i, col);
      applyMatrix(ring, i, x, y, 0.016, 1, 1, 1, 0);
      col.set(roleColor).multiplyScalar(2.5);
      ring.setColorAt(i, col);
    });
    ring.instanceMatrix.needsUpdate = true;
    glow.instanceMatrix.needsUpdate = true;
    if (ring.instanceColor) ring.instanceColor.needsUpdate = true;
    if (glow.instanceColor) glow.instanceColor.needsUpdate = true;
  }, [active, activeMap, mirror]);

  useFrame(({ clock }) => {
    if (!glowMatRef.current || !active.length) return;
    const t = clock.getElapsedTime();
    glowMatRef.current.opacity =
      0.18 + 0.12 * Math.sin(t * 2.0) + 0.06 * Math.sin(t * 0.75 + 1.1);
  });

  if (!entries.length) return null;

  return (
    <>
      <instancedMesh ref={glowRef} args={[RING_GLOW_PLANE, undefined, entries.length]} renderOrder={5}>
        <meshBasicMaterial
          ref={glowMatRef}
          map={GLOW_TEX}
          transparent opacity={0.10}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide} depthWrite={false}
        />
      </instancedMesh>
      <instancedMesh ref={ringRef} args={[RING_GEO, undefined, entries.length]} renderOrder={6}>
        <meshBasicMaterial transparent opacity={0.92} side={THREE.DoubleSide} depthWrite={false} />
      </instancedMesh>
    </>
  );
}

// ─── Camera rig ───────────────────────────────────────────────────────────────
function CameraRig({ azimuthRef, panYRef, invertPanRef }) {
  const { camera, gl } = useThree();
  const radiusRef   = useRef(CAM_RADIUS_DEF);
  const smoothAz    = useRef(AZ_DEFAULT * Math.PI / 180);
  const smoothH     = useRef(0);
  const rotVel      = useRef(0);  // inertia

  // ── Wheel zoom ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = gl.domElement;
    const onWheel = e => {
      e.preventDefault();
      radiusRef.current = clamp(radiusRef.current + e.deltaY * 0.02, CAM_RADIUS_MIN, CAM_RADIUS_MAX);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [gl]);

  // ── Touch: 1-finger orbit (horizontal=azimuth, vertical=height), 2-finger pinch ──
  useEffect(() => {
    const el = gl.domElement;
    let lastX = 0, lastY = 0;
    let lastDist = 0;
    let lastTime = 0;
    let prevAz = 0;
    let isPinching = false;

    const onTouchStart = e => {
      if (e.touches.length === 2) {
        isPinching = true;
        lastDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY,
        );
      } else {
        isPinching = false;
        lastX = e.touches[0].clientX;
        lastY = e.touches[0].clientY;
        lastTime = performance.now();
        prevAz = azimuthRef.current;
        rotVel.current = 0;
      }
    };

    const onTouchMove = e => {
      e.preventDefault();
      if (isPinching && e.touches.length === 2) {
        const dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY,
        );
        radiusRef.current = clamp(radiusRef.current - (dist - lastDist) * 0.04, CAM_RADIUS_MIN, CAM_RADIUS_MAX);
        lastDist = dist;
        return;
      }
      if (e.touches.length !== 1 || isPinching) return;

      const now = performance.now();
      const dx = e.touches[0].clientX - lastX;
      const dy = lastY - e.touches[0].clientY;
      const dt = Math.max(1, now - lastTime);

      const newAz = clamp(azimuthRef.current - dx * ROT_SCALE, AZ_MIN, AZ_MAX);
      rotVel.current = (newAz - prevAz) / dt * 6;  // deg/frame at 60fps
      prevAz = azimuthRef.current;
      azimuthRef.current = newAz;
      const panDir = invertPanRef?.current ? -1 : 1;
      panYRef.current = clamp(panYRef.current + dy * PAN_SCALE * panDir, PAN_MIN, PAN_MAX);

      lastX = e.touches[0].clientX;
      lastY = e.touches[0].clientY;
      lastTime = now;
    };

    const onTouchEnd = () => { isPinching = false; };

    el.addEventListener("touchstart",  onTouchStart, { passive: true });
    el.addEventListener("touchmove",   onTouchMove,  { passive: false });
    el.addEventListener("touchend",    onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    return () => {
      el.removeEventListener("touchstart",  onTouchStart);
      el.removeEventListener("touchmove",   onTouchMove);
      el.removeEventListener("touchend",    onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [gl, azimuthRef, panYRef]);

  // ── Mouse: drag orbit (desktop) ─────────────────────────────────────────────
  useEffect(() => {
    const el = gl.domElement;
    let startX = 0, startY = 0;
    let azStart = 0, panStart = 0;
    let dragging = false;

    const onMouseDown = e => {
      startX   = e.clientX; startY  = e.clientY;
      azStart  = azimuthRef.current; panStart = panYRef.current;
      dragging = true;
      rotVel.current = 0;
    };
    const onMouseMove = e => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = startY - e.clientY;
      const panDir = invertPanRef?.current ? -1 : 1;
      azimuthRef.current = clamp(azStart - dx * ROT_SCALE_MS, AZ_MIN, AZ_MAX);
      panYRef.current    = clamp(panStart + dy * PAN_SCALE * panDir, PAN_MIN, PAN_MAX);
    };
    const onMouseUp = () => { dragging = false; };

    el.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup",   onMouseUp);
    return () => {
      el.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup",   onMouseUp);
    };
  }, [gl, azimuthRef, panYRef]);

  useFrame(() => {
    // Inertia: decay rotation velocity after finger lifts
    if (Math.abs(rotVel.current) > 0.001) {
      rotVel.current *= 0.82;
      azimuthRef.current = clamp(azimuthRef.current + rotVel.current, AZ_MIN, AZ_MAX);
    }

    const azTarget = azimuthRef.current * Math.PI / 180;
    smoothAz.current += (azTarget          - smoothAz.current) * 0.10;
    smoothH.current  += (panYRef.current   - smoothH.current)  * 0.10;

    const theta = smoothAz.current;
    const phi   = CAM_POLAR;
    const r     = radiusRef.current;

    camera.position.set(
      r * Math.sin(phi) * Math.sin(theta),
      r * Math.cos(phi) + smoothH.current,
      r * Math.sin(phi) * Math.cos(theta),
    );
    camera.lookAt(CAM_LOOKAT);
  });

  return null;
}

// ─── Board face ───────────────────────────────────────────────────────────────
function BoardFace({ mirror }) {
  const [plastic, wood] = useTexture(["/tb2-plastic.png", "/tb2-wood.png"]);

  useMemo(() => {
    for (const tex of [plastic, wood]) {
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.repeat.x = mirror ? -1 : 1;
      tex.offset.x = mirror ? 1  : 0;
      tex.needsUpdate = true;
    }
  }, [plastic, wood, mirror]);

  return (
    <group>
      <mesh>
        <planeGeometry args={[BW, BH]} />
        {/* fully matte — no specular at any angle */}
        <meshStandardMaterial color="#1c1c1c" roughness={1.0} metalness={0} />
      </mesh>
      <mesh position={[0, 0, 0.003]} renderOrder={1}>
        <planeGeometry args={[BW, BH]} />
        <meshBasicMaterial map={plastic} color="#d0b890" transparent opacity={0.55}
          blending={THREE.MultiplyBlending} depthWrite={false} />
      </mesh>
      <mesh position={[0, 0, 0.006]} renderOrder={2}>
        <planeGeometry args={[BW, BH]} />
        <meshBasicMaterial map={wood} color="#d0a840" transparent opacity={0.32}
          blending={THREE.MultiplyBlending} depthWrite={false} />
      </mesh>
    </group>
  );
}

function BoardBody({ mirror }) {
  const d = FRAME_D;
  const edges = [
    { pos:[0,  BH/2 + d/2, -d/2], size:[BW + d*2, d, d] },
    { pos:[0, -BH/2 - d/2, -d/2], size:[BW + d*2, d, d] },
    { pos:[-BW/2 - d/2, 0, -d/2], size:[d, BH + d*2, d] },
    { pos:[ BW/2 + d/2, 0, -d/2], size:[d, BH + d*2, d] },
  ];
  return (
    <group>
      <Suspense fallback={
        <mesh>
          <planeGeometry args={[BW, BH]} />
          <meshStandardMaterial color="#1c1c1c" roughness={1.0} metalness={0} />
        </mesh>
      }>
        <BoardFace mirror={mirror} />
      </Suspense>
      {edges.map(({ pos, size }, i) => (
        <mesh key={i} position={pos}>
          <boxGeometry args={size} />
          <meshStandardMaterial color="#505050" roughness={0.18} metalness={0.45} />
        </mesh>
      ))}
    </group>
  );
}

// ─── Kicker board ─────────────────────────────────────────────────────────────
function KickerBoard() {
  return (
    <mesh position={[0, -(BH / 2) - KICK_H / 2, -(KICK_D / 2)]}>
      <boxGeometry args={[BW + FRAME_D * 2, KICK_H, KICK_D]} />
      <meshStandardMaterial color="#505050" roughness={0.18} metalness={0.45}
        polygonOffset polygonOffsetFactor={2} polygonOffsetUnits={2} />
    </mesh>
  );
}

// ─── Floor grid ───────────────────────────────────────────────────────────────
// Pattern A — dual-tone crosshatch: grey cells + purple section highlights
function FloorGrid() {
  return (
    <Grid
      args={[1000, 1000]}
      position={[0, FLOOR_Y, 0]}
      cellSize={0.6}
      cellThickness={0.5}
      cellColor="#3a3a3a"
      sectionSize={3}
      sectionThickness={1.2}
      sectionColor="#555555"
      fadeDistance={120}
      fadeStrength={1.5}
      followCamera
      infiniteGrid
    />
  );
}

// Pattern B — diamond grid (45° rotation)
// function FloorGrid() {
//   return (
//     <group rotation={[0, Math.PI / 4, 0]}>
//       <Grid
//         args={[1000, 1000]}
//         position={[0, FLOOR_Y, 0]}
//         cellSize={0.9}
//         cellThickness={0.6}
//         cellColor="#383838"
//         sectionSize={4.5}
//         sectionThickness={1.3}
//         sectionColor="#8b5cf6"
//         fadeDistance={120}
//         fadeStrength={1.5}
//         followCamera
//         infiniteGrid
//       />
//     </group>
//   );
// }

// Pattern C — fine micro grid
// function FloorGrid() {
//   return (
//     <Grid
//       args={[1000, 1000]}
//       position={[0, FLOOR_Y, 0]}
//       cellSize={0.25}
//       cellThickness={0.6}
//       cellColor="#2e2e2e"
//       sectionSize={1.25}
//       sectionThickness={1.0}
//       sectionColor="#5b21b6"
//       fadeDistance={120}
//       fadeStrength={1.5}
//       followCamera
//       infiniteGrid
//     />
//   );
// }

// ─── Scene ────────────────────────────────────────────────────────────────────
function Scene({ problem, placements, mirror, angle, azimuthRef, panYRef, invertPanRef }) {
  const tilt = ((angle ?? 40) * Math.PI) / 180;

  const activeMap = useMemo(() => {
    const m = {};
    (problem?.holds ?? []).forEach(h => {
      if (h?.id != null && h?.role) m[h.id] = h.role;
    });
    return m;
  }, [problem]);

  return (
    <>
      <ambientLight intensity={0.75} color="#ede8ff" />
      <directionalLight position={[3, 10, 8]}   intensity={1.2}  color="#ffffff" />
      <directionalLight position={[-5, 4, 10]}  intensity={0.6}  color="#ffffff" />
      <directionalLight position={[0, -4, 6]}   intensity={0.22} color="#9977ff" />
      {/* frontal fill — shoots straight at the board face to light hold surfaces */}
      <directionalLight position={[0, 2, 20]}   intensity={0.9}  color="#fff8f0" />

      <CameraRig azimuthRef={azimuthRef} panYRef={panYRef} invertPanRef={invertPanRef} />

      {/* Board group — pivots at bottom edge */}
      <group position={[0, -(BH / 2), 0]}>
        <group rotation={[tilt, 0, 0]}>
          <group position={[0, BH / 2, 0]}>
            <BoardBody mirror={mirror} />
            <InactiveHoldBumps placements={placements} activeMap={activeMap} mirror={mirror} />
            <ActiveRings       placements={placements} activeMap={activeMap} mirror={mirror} />
          </group>
        </group>
      </group>

      {/* Kicker — world space, stays vertical */}
      <KickerBoard />

      <FloorGrid />
    </>
  );
}

// ─── HUD ──────────────────────────────────────────────────────────────────────
function ClimbInfo({ problem }) {
  if (!problem) return null;
  return (
    <div style={{
      position:"absolute", top:0, left:0, right:0,
      padding:"14px 56px 28px",
      background:"linear-gradient(to bottom, rgba(0,0,0,0.70) 0%, rgba(0,0,0,0) 100%)",
      display:"flex", flexDirection:"column", alignItems:"center", gap:5,
      pointerEvents:"none",
    }}>
      {problem.name && (
        <div style={{
          fontFamily:"'Geist',sans-serif", fontWeight:800, fontSize:14,
          letterSpacing:"0.06em", textTransform:"uppercase",
          color:"rgba(255,255,255,0.92)", textAlign:"center",
        }}>{problem.name}</div>
      )}
      <div style={{
        display:"flex", gap:10, alignItems:"center", flexWrap:"wrap", justifyContent:"center",
        fontFamily:"'Geist Mono',monospace", fontSize:10, letterSpacing:"0.10em",
        color:"rgba(255,255,255,0.48)",
      }}>
        {problem.grade  && <span style={{color:"rgba(255,255,255,0.75)"}}>{problem.grade}</span>}
        {problem.angle != null && <span>{problem.angle}°</span>}
        {problem.setter && <span>@{problem.setter}</span>}
      </div>
    </div>
  );
}

function Legend({ problem }) {
  if (!problem?.holds?.length) return null;
  const roles  = [...new Set(problem.holds.map(h => h.role))];
  const labels = { start:"Start", hand:"Hand", finish:"Finish", foot:"Foot" };
  return (
    <div style={{ position:"absolute", bottom:72, right:14, display:"flex", flexDirection:"column", gap:5, pointerEvents:"none" }}>
      {roles.map(role => (
        <div key={role} style={{ display:"flex", alignItems:"center", gap:6 }}>
          <div style={{ width:10, height:10, borderRadius:"50%", background: ROLE_COLOR[role] ?? ROLE_COLOR_FALLBACK, flexShrink:0 }} />
          <span style={{ fontFamily:"'Geist Mono',monospace", fontSize:9, letterSpacing:"0.12em", color:"rgba(255,255,255,0.50)" }}>
            {labels[role] ?? role}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Stable module-level Canvas config ────────────────────────────────────────
const CAMERA_CONFIG = { position:[0, -3.2, 21.0], fov:52, near:0.5, far:80 };
const GL_CONFIG     = {
  antialias: true,
  toneMapping: THREE.ACESFilmicToneMapping,
  toneMappingExposure: 0.85,
};
const CANVAS_STYLE  = { background:"#0d0d0d", width:"100%", height:"100%", touchAction:"none" };

// ─── Error boundary ───────────────────────────────────────────────────────────
class Canvas3DErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          display:"flex", alignItems:"center", justifyContent:"center",
          width:"100%", height:"100%",
          color:"rgba(255,255,255,0.30)", fontFamily:"'Geist Mono',monospace",
          fontSize:11, letterSpacing:"0.12em",
        }}>
          3D VIEW UNAVAILABLE
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────
export default function Board3D({ problem, placements, mirror, angle, problems = [], onNavigate }) {
  const azimuthRef                    = useRef(AZ_DEFAULT);
  const panYRef                       = useRef(0);
  const invertPanRef                  = useRef(false);
  const [invertPan, setInvertPan]     = useState(false);
  const [hintVisible, setHintVisible] = useState(true);
  const [loaded,      setLoaded]      = useState(false);
  const [localAngle, setLocalAngle]   = useState(angle ?? 40);

  useEffect(() => { setLocalAngle(angle ?? 40); }, [angle]);
  useEffect(() => {
    const t = setTimeout(() => setHintVisible(false), 3200);
    return () => clearTimeout(t);
  }, []);

  const currentIndex = useMemo(
    () => problems.findIndex(p => p.uuid && p.uuid === problem?.uuid),
    [problems, problem],
  );
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < problems.length - 1;
  const goPrev  = () => hasPrev && onNavigate?.(problems[currentIndex - 1]);
  const goNext  = () => hasNext && onNavigate?.(problems[currentIndex + 1]);

  return (
    <div style={{ position:"relative", width:"100%", height:"100%" }}>
      <style>{`
        .tt-slider { appearance:none; -webkit-appearance:none; outline:none; background:transparent; cursor:ew-resize; width:100%; }
        .tt-slider::-webkit-slider-runnable-track { height:2px; background:rgba(255,255,255,0.18); border-radius:1px; }
        .tt-slider::-webkit-slider-thumb { -webkit-appearance:none; width:18px; height:18px; border-radius:50%; background:rgba(255,255,255,0.88); margin-top:-8px; box-shadow:0 0 8px rgba(255,255,255,0.30); transition:box-shadow .15s; }
        .tt-slider:active::-webkit-slider-thumb { background:#fff; box-shadow:0 0 16px rgba(255,255,255,0.55); }
        .tt-slider::-moz-range-track { height:2px; background:rgba(255,255,255,0.18); border-radius:1px; }
        .tt-slider::-moz-range-thumb { width:18px; height:18px; border-radius:50%; background:rgba(255,255,255,0.88); border:none; box-shadow:0 0 8px rgba(255,255,255,0.30); }
      `}</style>

      <Canvas3DErrorBoundary>
        <Canvas
          camera={CAMERA_CONFIG}
          style={CANVAS_STYLE}
          gl={GL_CONFIG}
          dpr={[1, 1.5]}
          onCreated={() => setLoaded(true)}
        >
          <Scene
            problem={problem}
            placements={placements}
            mirror={mirror}
            angle={localAngle}
            azimuthRef={azimuthRef}
            panYRef={panYRef}
            invertPanRef={invertPanRef}
          />
        </Canvas>
      </Canvas3DErrorBoundary>

      {/* Loading overlay — fades once renderer is ready */}
      <div style={{
        position:"absolute", inset:0,
        background:"#0d0d0d",
        display:"flex", alignItems:"center", justifyContent:"center",
        pointerEvents:"none",
        opacity: loaded ? 0 : 1,
        transition:"opacity 0.4s ease",
      }}>
        <div style={{
          fontFamily:"'Geist Mono',monospace", fontSize:9, letterSpacing:"0.16em",
          color:"rgba(255,255,255,0.20)",
        }}>LOADING</div>
      </div>

      <ClimbInfo problem={problem} />
      <Legend    problem={problem} />

      {/* Pan direction toggle */}
      <button
        onClick={() => {
          invertPanRef.current = !invertPanRef.current;
          setInvertPan(v => !v);
        }}
        title={invertPan ? "Pan: inverted" : "Pan: normal"}
        style={{
          position:"absolute", top:14, left:14,
          background:"rgba(0,0,0,0.55)", border:"1px solid rgba(255,255,255,0.14)",
          borderRadius:6, padding:"5px 9px", cursor:"pointer",
          fontFamily:"'Geist Mono',monospace", fontSize:9,
          color: invertPan ? "rgba(168,85,247,0.9)" : "rgba(255,255,255,0.35)",
          letterSpacing:"0.08em", pointerEvents:"all", lineHeight:1,
        }}
      >{invertPan ? "↕ INV" : "↕ PAN"}</button>

      {hasPrev && (
        <button onClick={goPrev} style={{
          position:"absolute", left:0, top:"50%", transform:"translateY(-50%)",
          width:48, height:80, background:"none", border:"none",
          cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center",
          pointerEvents:"all",
        }}>
          <svg width="13" height="24" viewBox="0 0 13 24" fill="none">
            <polyline points="10,2 3,12 10,22" stroke="rgba(255,255,255,0.55)" strokeWidth="2.5"
              strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      )}

      {hasNext && (
        <button onClick={goNext} style={{
          position:"absolute", right:0, top:"50%", transform:"translateY(-50%)",
          width:48, height:80, background:"none", border:"none",
          cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center",
          pointerEvents:"all",
        }}>
          <svg width="13" height="24" viewBox="0 0 13 24" fill="none">
            <polyline points="3,2 10,12 3,22" stroke="rgba(255,255,255,0.55)" strokeWidth="2.5"
              strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      )}

      {/* Angle picker */}
      <div style={{
        position:"absolute", top:14, right:14,
        display:"flex", flexDirection:"column", alignItems:"flex-end", gap:5,
        pointerEvents:"all",
      }}>
        <div style={{
          fontSize:9, fontFamily:"'Geist Mono',monospace", letterSpacing:"0.12em",
          color:"rgba(255,255,255,0.30)", marginBottom:1,
        }}>{localAngle}° ANGLE</div>
        <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
          {BOARD_ANGLES.slice().reverse().map(a => (
            <button key={a} onClick={() => setLocalAngle(a)} style={{
              background: a === localAngle ? "rgba(255,255,255,0.92)" : "rgba(0,0,0,0.55)",
              border: `1px solid ${a === localAngle ? "rgba(255,255,255,0.90)" : "rgba(255,255,255,0.14)"}`,
              color: a === localAngle ? "#0d0d0d" : "rgba(255,255,255,0.45)",
              borderRadius:4, padding:"4px 8px", fontSize:9,
              fontFamily:"'Geist Mono',monospace",
              fontWeight: a === localAngle ? 700 : 400,
              cursor:"pointer", lineHeight:1, minWidth:32,
              textAlign:"center", transition:"all 0.12s",
            }}>{a}</button>
          ))}
        </div>
      </div>

      {/* Rotation slider — bottom centre */}
      <div style={{
        position:"absolute", bottom:22, left:"50%", transform:"translateX(-50%)",
        display:"flex", alignItems:"center", gap:10,
        width:"min(72%, 300px)", pointerEvents:"all",
      }}>
        <svg width="8" height="14" viewBox="0 0 8 14" fill="none" style={{ flexShrink:0 }}>
          <polyline points="7,1 1,7 7,13" stroke="rgba(255,255,255,0.32)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <input type="range" className="tt-slider"
          min={AZ_MIN} max={AZ_MAX}
          defaultValue={AZ_DEFAULT}
          onChange={e => { azimuthRef.current = Number(e.target.value); }}
        />
        <svg width="8" height="14" viewBox="0 0 8 14" fill="none" style={{ flexShrink:0 }}>
          <polyline points="1,1 7,7 1,13" stroke="rgba(255,255,255,0.32)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>

      {/* Vertical height slider — left side, below nav arrows */}
      <div style={{
        position:"absolute", left:14, top:"calc(50% + 52px)",
        display:"flex", flexDirection:"column", alignItems:"center", gap:8,
        pointerEvents:"all",
      }}>
        <svg width="14" height="9" viewBox="0 0 14 9" fill="none" style={{ flexShrink:0 }}>
          <polyline points="1,8 7,2 13,8" stroke="rgba(255,255,255,0.32)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <div style={{ width:22, height:130, position:"relative", display:"flex", alignItems:"center", justifyContent:"center" }}>
          <input type="range" className="tt-slider"
            min={-40} max={80} step={1} defaultValue={0}
            style={{ width:130, transform:"rotate(-90deg)", position:"absolute" }}
            onChange={e => { panYRef.current = Number(e.target.value) / 10; }}
          />
          {/* tick at value=0 — IRL eye height */}
          <div style={{
            position:"absolute", top:87, right:-14,
            width:10, height:2, background:"rgba(255,255,255,0.45)",
            borderRadius:1, pointerEvents:"none",
          }} />
        </div>
        <svg width="14" height="9" viewBox="0 0 14 9" fill="none" style={{ flexShrink:0 }}>
          <polyline points="1,1 7,7 13,1" stroke="rgba(255,255,255,0.32)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <div style={{
          fontSize:8, fontFamily:"'Geist Mono',monospace", letterSpacing:"0.10em",
          color:"rgba(255,255,255,0.25)", writingMode:"vertical-rl",
          textOrientation:"mixed", transform:"rotate(180deg)", marginTop:2,
        }}>VIEW</div>
      </div>

      {/* Hint */}
      <div style={{
        position:"absolute", bottom:52, left:0, right:0, textAlign:"center",
        fontFamily:"'Geist Mono',monospace", fontSize:9, letterSpacing:"0.10em",
        color:"rgba(255,255,255,0.25)", pointerEvents:"none",
        opacity: hintVisible ? 1 : 0,
        transition:"opacity 1.2s ease",
      }}>
        DRAG TO ROTATE · PINCH TO ZOOM
      </div>
    </div>
  );
}
