#!/usr/bin/env python3
"""
Extracts TB2 Spray AND Mirror data from tension.db and writes JSON files for TensionTrack.

── Outputs ──────────────────────────────────────────────────────────────────
  src/data/placements.json           Spray hold layout  (bundled in JS)
  src/data/placements_mirror.json    Mirror hold layout (bundled in JS)
  public/data/climbs.json            Top 25 000 Spray community climbs
  public/data/climbs_mirror.json     Top 25 000 Mirror community climbs
  public/data/personal_climbs.json   Personal Spray climbs
  public/data/personal_climbs_mirror.json  Personal Mirror climbs

── Setup ────────────────────────────────────────────────────────────────────
1. Sync the official Tension Board 2 app on your phone so it downloads fresh data.
2. Copy tension.db off the device:
     iOS  → use iMazing or Finder device browser
     Android → adb pull /data/data/com.auroraclimbing.tensionboard/databases/tension.db
3. Place it at ~/Desktop/tension.db (or edit DB_PATH below).
4. Add your TB2 username(s) to PERSONAL_USERNAMES.
5. Run: python3 extract_tension_data.py

── Layout IDs (queried from layouts table) ──────────────────────────────────
   9  → Original Layout
  10  → Tension Board 2 Mirror   ← gyms like Vertical Ventures St Pete
  11  → Tension Board 2 Spray    ← standard/default
"""

import sqlite3, json, re, os, math

# ── Config ────────────────────────────────────────────────────────────────────
DB_PATH = os.path.expanduser("~/Desktop/tension.db")

PERSONAL_USERNAMES = ["Austinwray"]

SPRAY_LAYOUT_ID  = 11   # TB2 Spray  (standard)
MIRROR_LAYOUT_ID = 10   # TB2 Mirror (horizontally flipped board)

# ── Output dirs ───────────────────────────────────────────────────────────────
ROOT     = os.path.dirname(__file__)
SRC_DATA = os.path.join(ROOT, "src",    "data")
PUB_DATA = os.path.join(ROOT, "public", "data")
os.makedirs(SRC_DATA, exist_ok=True)
os.makedirs(PUB_DATA, exist_ok=True)

# ── Coordinate normalisation ──────────────────────────────────────────────────
# Both layouts share the same physical hold grid (x=[-64,64], y=[4,140]).
# Mirror holds are the horizontal flip of Spray holds at the DB level —
# i.e. spray x=-64 ↔ mirror x=+64 — so normalisation is identical for both.
X_MIN, X_MAX = -68, 68   # slight padding keeps holds off canvas edge
Y_MIN, Y_MAX =   0, 144

def norm_x(x): return round((x - X_MIN) / (X_MAX - X_MIN) * 100, 2)
def norm_y(y): return round((Y_MAX - y) / (Y_MAX - Y_MIN) * 100, 2)

ROLE_MAP  = {5: "start", 6: "hand", 7: "finish", 8: "foot"}
FRAMES_RE = re.compile(r'p(\d+)r(\d+)')

def parse_frames(frames_str):
    if not frames_str:
        return []
    return [
        {"id": int(pid), "role": ROLE_MAP.get(int(rid), "hand")}
        for pid, rid in FRAMES_RE.findall(frames_str)
    ]

# ── DB connection ─────────────────────────────────────────────────────────────
if not os.path.exists(DB_PATH):
    print(f"✗  tension.db not found at {DB_PATH}")
    print("   Sync the official TB2 app then copy the DB — see file header for instructions.")
    raise SystemExit(1)

con = sqlite3.connect(DB_PATH)
con.row_factory = sqlite3.Row
con.create_function("log",  1, math.log)
con.create_function("log2", 1, math.log2)
cur = con.cursor()

# ── Print available layouts (useful for future board support) ─────────────────
cur.execute("SELECT id, name FROM layouts ORDER BY id")
print("Available layouts in this DB:")
for row in cur.fetchall():
    print(f"  {row['id']:3d}: {row['name']}")
print()

# ── Helper: extract placements for a given layout ────────────────────────────
def extract_placements(layout_id):
    cur.execute("""
        SELECT p.id, h.x, h.y, p.default_placement_role_id
        FROM   placements p
        JOIN   holes h ON h.id = p.hole_id
        WHERE  p.layout_id = ?
        ORDER  BY h.y DESC, h.x ASC
    """, (layout_id,))
    result = {}
    for row in cur.fetchall():
        result[row["id"]] = {
            "x": norm_x(row["x"]),
            "y": norm_y(row["y"]),
            "default_role": ROLE_MAP.get(row["default_placement_role_id"], "hand"),
        }
    return result

# ── 1. Placements ─────────────────────────────────────────────────────────────
print("Extracting placements…")

spray_placements = extract_placements(SPRAY_LAYOUT_ID)
with open(os.path.join(SRC_DATA, "placements.json"), "w") as f:
    json.dump(spray_placements, f, separators=(",", ":"))
print(f"  → {len(spray_placements)} spray placements  →  src/data/placements.json")

mirror_placements = extract_placements(MIRROR_LAYOUT_ID)
with open(os.path.join(SRC_DATA, "placements_mirror.json"), "w") as f:
    json.dump(mirror_placements, f, separators=(",", ":"))
print(f"  → {len(mirror_placements)} mirror placements →  src/data/placements_mirror.json")

# ── 2. Grade map ──────────────────────────────────────────────────────────────
cur.execute("SELECT difficulty, boulder_name FROM difficulty_grades WHERE is_listed=1")
grade_map = {}
for row in cur.fetchall():
    m = re.search(r'V(\d+)', row["boulder_name"])
    if m:
        grade_map[row["difficulty"]] = f"V{m.group(1)}"

def difficulty_to_vgrade(d):
    if d is None:
        return "V?"
    key = math.floor(d)
    for k in [key, key-1, key+1, key+2]:
        if k in grade_map:
            return grade_map[k]
    return "V?"

def row_to_climb(row):
    holds = parse_frames(row["frames"])
    if not holds:
        return None
    return {
        "uuid":       row["uuid"],
        "name":       row["name"],
        "setter":     row["setter_username"],
        "angle":      row["angle"],
        "grade":      difficulty_to_vgrade(row["display_difficulty"]),
        "difficulty": round(row["display_difficulty"], 2) if row["display_difficulty"] else None,
        "quality":    round(row["quality_average"], 2)    if row["quality_average"]    else 0.0,
        "ascents":    row["ascensionist_count"]            if row["ascensionist_count"] else 0,
        "date":       row["created_at"][:10]               if row["created_at"]         else None,
        "holds":      holds,
    }

# ── Helper: extract community climbs for a layout ────────────────────────────
def extract_community_climbs(layout_id, limit=25000):
    cur.execute("""
        SELECT
            c.uuid, c.name, c.setter_username, c.angle, c.frames, c.created_at,
            cs.display_difficulty, cs.quality_average, cs.ascensionist_count
        FROM   climbs c
        JOIN   climb_stats cs ON cs.climb_uuid = c.uuid AND cs.angle = c.angle
        WHERE  c.layout_id  = ?
          AND  c.is_listed  = 1
        ORDER  BY (cs.quality_average * log(cs.ascensionist_count + 1)) DESC
        LIMIT  ?
    """, (layout_id, limit))
    result = []
    for row in cur.fetchall():
        c = row_to_climb(row)
        if c:
            result.append(c)
    return result

# ── Helper: extract personal climbs for a layout ──────────────────────────────
def extract_personal_climbs(layout_id, usernames):
    if not usernames:
        return []
    placeholders = ",".join("?" * len(usernames))
    cur.execute(f"""
        SELECT
            c.uuid, c.name, c.setter_username, c.angle, c.frames, c.created_at,
            cs.display_difficulty, cs.quality_average, cs.ascensionist_count
        FROM   climbs c
        LEFT   JOIN climb_stats cs ON cs.climb_uuid = c.uuid AND cs.angle = c.angle
        WHERE  c.layout_id       = ?
          AND  c.setter_username IN ({placeholders})
        ORDER  BY c.created_at DESC
    """, [layout_id] + usernames)
    result = []
    for row in cur.fetchall():
        c = row_to_climb(row)
        if c:
            c["personal"] = True
            result.append(c)
    return result

# ── 3. Community climbs ───────────────────────────────────────────────────────
print("Extracting community climbs…")

spray_climbs = extract_community_climbs(SPRAY_LAYOUT_ID)
with open(os.path.join(PUB_DATA, "climbs.json"), "w") as f:
    json.dump(spray_climbs, f, separators=(",", ":"))
print(f"  → {len(spray_climbs):,} spray climbs   →  public/data/climbs.json")

mirror_climbs = extract_community_climbs(MIRROR_LAYOUT_ID)
with open(os.path.join(PUB_DATA, "climbs_mirror.json"), "w") as f:
    json.dump(mirror_climbs, f, separators=(",", ":"))
print(f"  → {len(mirror_climbs):,} mirror climbs  →  public/data/climbs_mirror.json")

# ── 4. Personal climbs ────────────────────────────────────────────────────────
if PERSONAL_USERNAMES:
    print(f"Extracting personal climbs for: {PERSONAL_USERNAMES}…")

    spray_personal = extract_personal_climbs(SPRAY_LAYOUT_ID, PERSONAL_USERNAMES)
    with open(os.path.join(PUB_DATA, "personal_climbs.json"), "w") as f:
        json.dump(spray_personal, f, separators=(",", ":"))
    print(f"  → {len(spray_personal)} spray personal   →  public/data/personal_climbs.json")

    mirror_personal = extract_personal_climbs(MIRROR_LAYOUT_ID, PERSONAL_USERNAMES)
    with open(os.path.join(PUB_DATA, "personal_climbs_mirror.json"), "w") as f:
        json.dump(mirror_personal, f, separators=(",", ":"))
    print(f"  → {len(mirror_personal)} mirror personal  →  public/data/personal_climbs_mirror.json")
else:
    for fname in ["personal_climbs.json", "personal_climbs_mirror.json"]:
        with open(os.path.join(PUB_DATA, fname), "w") as f:
            json.dump([], f)
    print("  (no PERSONAL_USERNAMES set — edit the top of this file to add yours)")

con.close()
print("\nDone. Re-run whenever you sync a fresh tension.db from the app.")
