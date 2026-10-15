/**
 * Scene probes: the checks that catch the defects screenshots and compilers
 * cannot see.
 *
 * Every bug found while building three Tron levels through the Editor had the
 * same shape. It compiled. It saved. It screenshotted convincingly from at
 * least one angle. And it was wrong in a way only motion or contact would
 * reveal:
 *
 *  - A 32-step stair built INSIDE a solid mountain. Correct step count, correct
 *    riser height, correct arithmetic; the flight started at the rock face and
 *    climbed inward, so every tread was buried and the player stood on a
 *    terrace facing a sheer wall.
 *  - A disc that stalled dead in mid-air on a corner hit, because the physics
 *    solver zeroes a velocity before the collision callback reads it.
 *  - A light cycle at 26 m/s passing through 0.18m trigger walls: 0.52m of
 *    travel per physics step against a 0.18m volume.
 *
 * Three probes, in the order of how much they would have saved:
 *
 *  1. `unity_walk_probe` — walk a capsule from A to B with the same collide,
 *     step-up and ground rules a CharacterController uses, and report where it
 *     stopped. This is the only check that would have caught the stair.
 *  2. `unity_scene_overlaps` — find walkable surfaces buried inside other
 *     colliders, and deep collider interpenetrations.
 *  3. `unity_scene_audit` — the cheap structural checks: no camera, no light,
 *     missing script references, NaN transforms, colliders thin enough to be
 *     tunnelled.
 *
 * All three run as C# sent to the open Editor, with nothing installed in the
 * project: a probe that needs a file committed to the project is a probe that
 * does not exist on the first run, which is exactly when it is needed.
 *
 * None of them needs play mode, which is deliberate. Play mode does not tick
 * while the Editor window is unfocused, and an entire playtest was once read off
 * a single frozen frame. Every probe here is query-based — casts and overlap
 * tests — so it answers the same in a frozen editor as in a running one.
 */

import { execFileSync } from "child_process";
import { localToolRegistry } from "./tools.js";
import { findUnityProject } from "./unityTools.js";
import { unityCliPath } from "./mcpServers.js";

/** Hard cap on a probe's C# payload run time. */
const PROBE_TIMEOUT_SECONDS = 90;

interface EvalOutcome {
  ok: boolean;
  data?: any;
  error?: string;
}

/**
 * Send C# to the Editor and bring back its parsed result.
 *
 * Routed through the `unity` CLI rather than the MCP server so a probe works
 * whether or not this session happens to have the Unity MCP tools connected —
 * the CLI talks to the same pipeline server either way.
 */
function evalInEditor(projectRoot: string, code: string): EvalOutcome {
  const cli = unityCliPath();
  if (!cli) {
    return { ok: false, error: "The Unity CLI is not installed, so no Editor can be reached." };
  }

  try {
    const raw = execFileSync(
      cli,
      [
        "command",
        "eval",
        code,
        "--json",
        "--project-path",
        projectRoot,
        "--timeout",
        String(PROBE_TIMEOUT_SECONDS),
        "--non-interactive",
        "--no-banner",
      ],
      {
        encoding: "utf-8",
        timeout: (PROBE_TIMEOUT_SECONDS + 20) * 1000,
        maxBuffer: 32 * 1024 * 1024,
      }
    );

    const parsed = JSON.parse(raw);
    const result = parsed?.data?.result;

    if (parsed?.success === false || result?.success === false) {
      const diagnostics = Array.isArray(result?.diagnostics)
        ? result.diagnostics.map((d: any) => d?.message ?? String(d)).join("; ")
        : "";
      return {
        ok: false,
        error: diagnostics || result?.error || "The Editor refused the probe.",
      };
    }

    // The payloads below always `return` a JSON string.
    const text = typeof result?.result === "string" ? result.result : JSON.stringify(result?.result);
    try {
      return { ok: true, data: JSON.parse(text) };
    } catch {
      return { ok: false, error: `The probe returned text that is not JSON: ${String(text).slice(0, 300)}` };
    }
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err).slice(0, 400) };
  }
}

/** Resolve which project to probe, preferring an explicit path. */
function resolveProject(explicit?: string): { root: string } | { error: any } {
  const start = typeof explicit === "string" && explicit.trim() ? explicit.trim() : process.cwd();
  const found = findUnityProject(start);

  if (found) return { root: found.root };

  return {
    error: {
      error: true,
      message: `No Unity project found at or above "${start}".`,
      actionRequired:
        "Pass projectPath pointing at the folder that contains Assets/ and ProjectSettings/.",
    },
  };
}

/** C# string literal, for embedding a caller's value in a payload. */
function csString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n")}"`;
}

function csFloat(value: number, fallback: number): string {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return `${n}f`;
}

// ---------------------------------------------------------------------------
// 1. Walk probe.
// ---------------------------------------------------------------------------

/**
 * Build the walking payload.
 *
 * Reimplements the parts of CharacterController that decide whether a route
 * exists — a forward capsule cast, a step-up retry, a slide along the
 * obstruction, and a ground check after each move — rather than driving a real
 * CharacterController. A real one only integrates inside the player loop, which
 * means play mode, which means focus, which is the thing that made the earlier
 * playtests worthless. Casts answer identically in a frozen editor.
 */
export function walkProbePayload(options: {
  from: [number, number, number];
  /** Waypoints in order, ending at the destination. */
  route: Array<[number, number, number]>;
  radius: number;
  height: number;
  stepHeight: number;
  stride: number;
  maxSteps: number;
  fallLimit: number;
}): string {
  const [fx, fy, fz] = options.from;
  const waypoints = options.route
    .map(([x, y, z]) => `new Vector3(${csFloat(x, 0)}, ${csFloat(y, 0)}, ${csFloat(z, 0)})`)
    .join(", ");

  return `
// Physics positions, not transform positions.
//
// Moving objects by transform leaves the physics scene holding their old
// positions until it is told otherwise, and in the Editor nothing tells it. A
// probe that skips this reports on where the geometry USED to be — which is the
// most misleading answer it could possibly give.
Physics.SyncTransforms();

var from = new Vector3(${csFloat(fx, 0)}, ${csFloat(fy, 0)}, ${csFloat(fz, 0)});
var route = new Vector3[] { ${waypoints} };
float radius = ${csFloat(options.radius, 0.35)};
float height = ${csFloat(options.height, 1.8)};
float stepHeight = ${csFloat(options.stepHeight, 0.4)};
float stride = ${csFloat(options.stride, 0.35)};
int maxSteps = ${Math.max(1, Math.round(options.maxSteps))};
float fallLimit = ${csFloat(options.fallLimit, 4)};

float half = Mathf.Max(height * 0.5f, radius + 0.01f);
var log = new System.Collections.Generic.List<string>();
var blockers = new System.Collections.Generic.Dictionary<string, int>();

// Capsule end points for a capsule standing at a foot position.
System.Func<Vector3, Vector3> bottom = foot => foot + Vector3.up * radius;
System.Func<Vector3, Vector3> top = foot => foot + Vector3.up * (height - radius);

// Anything already overlapping the start capsule is the walker itself, not an
// obstacle: the natural start position is where the player stands, and the
// player has a CharacterController. The first live run of this probe reported
// "NOT walkable, obstructed by Player" — a true statement about a collider that
// IS the thing doing the walking.
var self = new System.Collections.Generic.HashSet<Collider>();
foreach (var c in Physics.OverlapCapsule(bottom(from), top(from), radius * 1.05f, ~0, QueryTriggerInteraction.Ignore))
{
    if (c != null) self.Add(c);
}

System.Func<Vector3, Vector3, float, System.Collections.Generic.List<RaycastHit>> sweep = (foot, dir, dist) =>
{
    var kept = new System.Collections.Generic.List<RaycastHit>();
    foreach (var h in Physics.CapsuleCastAll(bottom(foot), top(foot), radius * 0.95f, dir, dist, ~0, QueryTriggerInteraction.Ignore))
    {
        if (h.collider == null || self.Contains(h.collider)) continue;
        kept.Add(h);
    }
    return kept;
};

// Drop to the ground, so the walk follows terrain instead of floating.
System.Func<Vector3, bool, Vector3> ground = (foot, snapUp) =>
{
    var origin = foot + Vector3.up * (stepHeight + 0.2f);

    // The NEAREST hit, not the first one returned.
    //
    // SphereCastAll does not order its results, and taking hits[0] made the
    // walker snap to whichever surface the physics scene happened to list first
    // — climbing a staircase it would sometimes ground itself on the step ahead
    // and sometimes on the one below, then stall between the two and report
    // being blocked by nothing it could name.
    bool found = false;
    float bestY = 0f;
    float bestDistance = float.MaxValue;

    foreach (var hit in Physics.SphereCastAll(origin, radius * 0.9f, Vector3.down, fallLimit + stepHeight + 0.4f, ~0, QueryTriggerInteraction.Ignore))
    {
        if (hit.collider == null || self.Contains(hit.collider)) continue;
        if (hit.distance >= bestDistance) continue;

        bestDistance = hit.distance;
        bestY = hit.point.y;
        found = true;
    }

    if (found) return new Vector3(foot.x, bestY + 0.02f, foot.z);
    return new Vector3(foot.x, float.NaN, foot.z);
};

// Push out of anything the capsule is already inside.
//
// Without this the probe gives false negatives the moment it brushes a wall: a
// capsule overlapping a collider gets distance-zero hits from every cast, reads
// them as an obstruction, and stops — measured on a walker that clipped the
// edge of a step next to a rock face and then reported the route blocked after
// grinding along it for 1,500 steps. A real CharacterController depenetrates
// every frame; so does this.
System.Func<Vector3, Vector3> depenetrate = foot =>
{
    var position = foot;

    for (int attempt = 0; attempt < 4; attempt++)
    {
        var centre = position + Vector3.up * (height * 0.5f);
        var overlapping = Physics.OverlapCapsule(bottom(position), top(position), radius * 0.95f, ~0, QueryTriggerInteraction.Ignore);

        var push = Vector3.zero;
        int count = 0;

        foreach (var c in overlapping)
        {
            if (c == null || self.Contains(c)) continue;

            var closest = c.ClosestPoint(centre);
            var away = centre - closest;
            away.y = 0f;

            if (away.sqrMagnitude < 0.0001f) continue;

            float distance = away.magnitude;
            float overlap = Mathf.Max(0f, radius - distance) + 0.04f;
            push += away.normalized * overlap;
            count++;
        }

        if (count == 0) break;
        position += push;
    }

    return position;
};

var current = depenetrate(ground(from, true));
bool startedInAir = float.IsNaN(current.y);
if (startedInAir) current = from;

float travelled = 0f;
int taken = 0;
string stopReason = "reached";
bool reached = false;
Vector3 lastProgressPoint = current;
int stalled = 0;

// Legs, not a straight line.
//
// A single straight probe answers "is there a clear line", which is almost
// never the question: the first live run walked from a terrace at the front of
// a mountain toward a lookout on top of it, hit the rock face, and correctly
// reported no route — while the real route went sideways to a stair and up. A
// route is a list of waypoints, and the useful answer is which leg failed.
int leg = 0;
var target = route[0];

for (taken = 0; taken < maxSteps; taken++)
{
    var toTarget = target - current;
    toTarget.y = 0f;
    float remaining = toTarget.magnitude;

    if (remaining <= Mathf.Max(stride, radius * 2f))
    {
        leg++;
        if (leg >= route.Length)
        {
            reached = true;
            stopReason = "reached";
            break;
        }

        target = route[leg];
        stalled = 0;
        continue;
    }

    var dir = toTarget / remaining;
    float want = Mathf.Min(stride, remaining);
    var hits = sweep(current, dir, want);

    Collider blocking = null;
    float nearest = float.MaxValue;
    foreach (var h in hits)
    {
        if (h.collider == null) continue;
        if (h.distance < nearest) { nearest = h.distance; blocking = h.collider; }
    }

    var next = current;

    if (blocking == null)
    {
        next = current + dir * want;
    }
    else
    {
        // Step up and try again: a stair tread is an obstruction you are meant
        // to climb, and without this every staircase reads as a wall.
        var raised = current + Vector3.up * (stepHeight + 0.05f);
        var raisedHits = sweep(raised, dir, want);
        bool clearAbove = raisedHits.Count == 0;

        if (clearAbove)
        {
            next = raised + dir * want;
        }
        else
        {
            // Slide along the obstruction, which is what a controller does at a
            // wall you are brushing rather than facing.
            var normal = Vector3.up;
            foreach (var h in hits) { if (h.collider == blocking) { normal = h.normal; break; } }

            var slide = Vector3.ProjectOnPlane(dir, normal).normalized;
            if (slide.sqrMagnitude > 0.01f)
            {
                var slideHits = sweep(current, slide, want);
                if (slideHits.Count == 0) next = current + slide * want;
            }

            string name = blocking.gameObject.name;
            if (!blockers.ContainsKey(name)) blockers[name] = 0;
            blockers[name]++;
        }
    }

    var grounded = ground(next, true);
    if (!float.IsNaN(grounded.y)) grounded = depenetrate(grounded);
    if (float.IsNaN(grounded.y))
    {
        stopReason = "no ground on leg " + (leg + 1) + " of " + route.Length +
            ": the next step has nothing to stand on within the fall limit";
        break;
    }

    float moved = Vector3.Distance(new Vector3(current.x, 0f, current.z), new Vector3(grounded.x, 0f, grounded.z));
    travelled += Vector3.Distance(current, grounded);
    current = grounded;

    if (moved < stride * 0.15f)
    {
        stalled++;
        if (stalled >= 8)
        {
            stopReason = "blocked on leg " + (leg + 1) + " of " + route.Length +
                ": no horizontal progress for 8 consecutive steps";
            break;
        }
    }
    else
    {
        stalled = 0;
        lastProgressPoint = current;
    }
}

if (taken >= maxSteps && !reached) stopReason = "step budget exhausted before arriving";

var sb = new System.Text.StringBuilder();
sb.Append("{");
sb.Append("\\"reached\\":").Append(reached ? "true" : "false");
sb.Append(",\\"stopReason\\":\\"").Append(stopReason).Append("\\"");
sb.Append(",\\"startedInAir\\":").Append(startedInAir ? "true" : "false");
sb.Append(",\\"stepsTaken\\":").Append(taken);
sb.Append(",\\"distanceWalked\\":").Append(travelled.ToString("F2"));
sb.Append(",\\"stoppedAt\\":{\\"x\\":").Append(current.x.ToString("F2"))
  .Append(",\\"y\\":").Append(current.y.ToString("F2"))
  .Append(",\\"z\\":").Append(current.z.ToString("F2")).Append("}");
sb.Append(",\\"remainingDistance\\":").Append(Vector3.Distance(new Vector3(current.x,0f,current.z), new Vector3(target.x,0f,target.z)).ToString("F2"));
sb.Append(",\\"legsCompleted\\":").Append(leg).Append(",\\"legsTotal\\":").Append(route.Length);
sb.Append(",\\"blockedBy\\":[");
bool first = true;
foreach (var kv in blockers)
{
    if (!first) sb.Append(",");
    first = false;
    sb.Append("{\\"name\\":\\"").Append(kv.Key.Replace("\\"", "")).Append("\\",\\"hits\\":").Append(kv.Value).Append("}");
}
sb.Append("]}");
return sb.ToString();
`.trim();
}

// ---------------------------------------------------------------------------
// 2. Overlap probe.
// ---------------------------------------------------------------------------

/**
 * Build the overlap payload.
 *
 * The headline check is `buriedSurfaces`, not raw interpenetration. Overlap on
 * its own is normal — a room carved into a rock mass is built from floor and
 * wall slabs placed inside that mass on purpose, and reporting those as errors
 * would make the probe useless in exactly the scenes that need it. What is
 * never intentional is a surface you are meant to stand on with solid matter
 * directly above it: that is the stair inside the mountain, and it is decidable
 * by sampling just above each collider's top face.
 */
export function overlapProbePayload(options: {
  minDepth: number;
  maxPairs: number;
  ignoreNames: string[];
}): string {
  const ignore = options.ignoreNames.map((n) => csString(n.toLowerCase())).join(", ");

  return `
// Physics positions, not transform positions.
//
// Moving objects by transform leaves the physics scene holding their old
// positions until it is told otherwise, and in the Editor nothing tells it. A
// probe that skips this reports on where the geometry USED to be — which is the
// most misleading answer it could possibly give.
Physics.SyncTransforms();

float minDepth = ${csFloat(options.minDepth, 0.05)};
int maxPairs = ${Math.max(1, Math.round(options.maxPairs))};
var ignore = new System.Collections.Generic.List<string> { ${ignore} };

var colliders = new System.Collections.Generic.List<Collider>();
foreach (var c in UnityEngine.Object.FindObjectsByType<Collider>(FindObjectsSortMode.None))
{
    if (c == null || c.isTrigger) continue;
    if (!c.gameObject.activeInHierarchy) continue;

    string lower = c.gameObject.name.ToLowerInvariant();
    bool skip = false;
    foreach (var token in ignore) { if (lower.Contains(token)) { skip = true; break; } }
    if (!skip) colliders.Add(c);
}

// Buried walkable surfaces: sample a little above each collider's top face and
// see whether that point is inside a DIFFERENT collider. Five samples (centre
// plus corners inset from the edges) so a surface half-buried under a wall is
// reported as partly buried rather than missed.
var buried = new System.Collections.Generic.List<string>();
int buriedCount = 0;

foreach (var c in colliders)
{
    var b = c.bounds;
    if (b.size.x < 0.05f || b.size.z < 0.05f) continue;

    float inset = 0.3f;
    var samples = new System.Collections.Generic.List<Vector3>
    {
        new Vector3(b.center.x, b.max.y + 0.12f, b.center.z),
        new Vector3(b.min.x + inset, b.max.y + 0.12f, b.min.z + inset),
        new Vector3(b.max.x - inset, b.max.y + 0.12f, b.min.z + inset),
        new Vector3(b.min.x + inset, b.max.y + 0.12f, b.max.z - inset),
        new Vector3(b.max.x - inset, b.max.y + 0.12f, b.max.z - inset),
    };

    int covered = 0;
    string insideOf = "";

    foreach (var p in samples)
    {
        var hits = Physics.OverlapSphere(p, 0.08f, ~0, QueryTriggerInteraction.Ignore);
        foreach (var h in hits)
        {
            if (h == c) continue;
            if (h.transform.IsChildOf(c.transform) || c.transform.IsChildOf(h.transform)) continue;

            // The player standing on a floor is not the floor being buried.
            if (h.GetComponentInParent<CharacterController>() != null) continue;

            covered++;
            if (insideOf.Length == 0) insideOf = h.gameObject.name;
            break;
        }
    }

    if (covered == 0) continue;

    buriedCount++;
    if (buried.Count < maxPairs)
    {
        buried.Add(
            "{\\"name\\":\\"" + c.gameObject.name.Replace("\\"", "") +
            "\\",\\"insideOf\\":\\"" + insideOf.Replace("\\"", "") +
            "\\",\\"samplesCovered\\":" + covered +
            ",\\"of\\":" + samples.Count +
            ",\\"topY\\":" + b.max.y.ToString("F2") + "}"
        );
    }
}

// Deep interpenetration, for the cases buried surfaces cannot see (two walls
// occupying the same space, a prop sunk into a floor).
var deep = new System.Collections.Generic.List<string>();
int deepCount = 0;

for (int i = 0; i < colliders.Count && deep.Count < maxPairs; i++)
{
    var a = colliders[i];
    for (int j = i + 1; j < colliders.Count; j++)
    {
        var b = colliders[j];
        if (!a.bounds.Intersects(b.bounds)) continue;
        if (a.transform.IsChildOf(b.transform) || b.transform.IsChildOf(a.transform)) continue;

        Vector3 direction;
        float distance;
        bool hit = Physics.ComputePenetration(
            a, a.transform.position, a.transform.rotation,
            b, b.transform.position, b.transform.rotation,
            out direction, out distance
        );

        if (!hit || distance < minDepth) continue;

        deepCount++;
        if (deep.Count < maxPairs)
        {
            deep.Add(
                "{\\"a\\":\\"" + a.gameObject.name.Replace("\\"", "") +
                "\\",\\"b\\":\\"" + b.gameObject.name.Replace("\\"", "") +
                "\\",\\"depth\\":" + distance.ToString("F2") + "}"
            );
        }
        if (deep.Count >= maxPairs) break;
    }
}

var sb = new System.Text.StringBuilder();
sb.Append("{\\"collidersChecked\\":").Append(colliders.Count);
sb.Append(",\\"buriedSurfaceCount\\":").Append(buriedCount);
sb.Append(",\\"buriedSurfaces\\":[").Append(string.Join(",", buried)).Append("]");
sb.Append(",\\"deepOverlapCount\\":").Append(deepCount);
sb.Append(",\\"deepOverlaps\\":[").Append(string.Join(",", deep)).Append("]");
sb.Append("}");
return sb.ToString();
`.trim();
}

// ---------------------------------------------------------------------------
// 3. Scene audit.
// ---------------------------------------------------------------------------

/**
 * Build the audit payload: the structural checks that are cheap and that a
 * generated scene gets wrong in bulk.
 *
 * `thinColliders` is here because of a measured bug rather than a guess: a light
 * cycle at 26 m/s passed straight through 0.18m trigger walls, because a physics
 * step at that speed covers 0.52m and the trigger volume fit between two
 * positions of the controller. Anything thinner than a tenth of a metre is a
 * tunnelling risk for anything fast, and the fix — a swept cast — has to be
 * chosen deliberately.
 */
export function auditProbePayload(options: { thinThreshold: number; maxItems: number }): string {
  return `
// Physics positions, not transform positions.
//
// Moving objects by transform leaves the physics scene holding their old
// positions until it is told otherwise, and in the Editor nothing tells it. A
// probe that skips this reports on where the geometry USED to be — which is the
// most misleading answer it could possibly give.
Physics.SyncTransforms();

float thin = ${csFloat(options.thinThreshold, 0.1)};
int maxItems = ${Math.max(1, Math.round(options.maxItems))};

var scene = UnityEditor.SceneManagement.EditorSceneManager.GetActiveScene();
int objects = 0;
var missingScripts = new System.Collections.Generic.List<string>();
var badTransforms = new System.Collections.Generic.List<string>();
var noMaterial = new System.Collections.Generic.List<string>();
var thinColliders = new System.Collections.Generic.List<string>();

foreach (var root in scene.GetRootGameObjects())
{
    foreach (var t in root.GetComponentsInChildren<Transform>(true))
    {
        objects++;
        var go = t.gameObject;

        var p = t.position;
        var s = t.lossyScale;
        if (float.IsNaN(p.x) || float.IsNaN(p.y) || float.IsNaN(p.z)
            || float.IsInfinity(p.x) || float.IsInfinity(p.y) || float.IsInfinity(p.z)
            || Mathf.Abs(p.x) > 100000f || Mathf.Abs(p.y) > 100000f || Mathf.Abs(p.z) > 100000f
            || s.x == 0f || s.y == 0f || s.z == 0f)
        {
            if (badTransforms.Count < maxItems) badTransforms.Add(go.name);
        }

        foreach (var component in go.GetComponents<Component>())
        {
            if (component == null && missingScripts.Count < maxItems)
            {
                missingScripts.Add(go.name);
                break;
            }
        }

        var renderer = go.GetComponent<Renderer>();
        if (renderer != null && renderer.sharedMaterial == null && noMaterial.Count < maxItems)
        {
            noMaterial.Add(go.name);
        }

        var collider = go.GetComponent<Collider>();
        if (collider != null)
        {
            var size = collider.bounds.size;
            float smallest = Mathf.Min(size.x, Mathf.Min(size.y, size.z));
            if (smallest > 0f && smallest < thin && thinColliders.Count < maxItems)
            {
                thinColliders.Add(
                    "{\\"name\\":\\"" + go.name.Replace("\\"", "") +
                    "\\",\\"thinnestAxis\\":" + smallest.ToString("F3") +
                    ",\\"isTrigger\\":" + (collider.isTrigger ? "true" : "false") + "}"
                );
            }
        }
    }
}

int cameras = 0;
foreach (var c in UnityEngine.Object.FindObjectsByType<Camera>(FindObjectsSortMode.None)) { if (c.enabled) cameras++; }

int lights = 0;
foreach (var l in UnityEngine.Object.FindObjectsByType<Light>(FindObjectsSortMode.None)) { if (l.enabled) lights++; }

System.Func<System.Collections.Generic.List<string>, string> quoted = list =>
{
    var parts = new System.Collections.Generic.List<string>();
    foreach (var item in list) parts.Add("\\"" + item.Replace("\\"", "") + "\\"");
    return string.Join(",", parts);
};

var sb = new System.Text.StringBuilder();
sb.Append("{\\"scene\\":\\"").Append(scene.name).Append("\\"");
sb.Append(",\\"objects\\":").Append(objects);
sb.Append(",\\"enabledCameras\\":").Append(cameras);
sb.Append(",\\"enabledLights\\":").Append(lights);
sb.Append(",\\"missingScripts\\":[").Append(quoted(missingScripts)).Append("]");
sb.Append(",\\"invalidTransforms\\":[").Append(quoted(badTransforms)).Append("]");
sb.Append(",\\"renderersWithNoMaterial\\":[").Append(quoted(noMaterial)).Append("]");
sb.Append(",\\"thinColliders\\":[").Append(string.Join(",", thinColliders)).Append("]");
sb.Append("}");
return sb.ToString();
`.trim();
}

// ---------------------------------------------------------------------------
// Verdicts. The probes return numbers; these turn them into the one line a
// caller should act on, because a model handed raw counts reports "the probe
// ran" and moves on.
// ---------------------------------------------------------------------------

export function walkVerdict(data: any): { passed: boolean; verdict: string; actionRequired?: string } {
  if (data?.reached === true) {
    return {
      passed: true,
      verdict:
        `Walkable: a capsule got from the start to within reach of the target in ` +
        `${data.stepsTaken} steps, ${data.distanceWalked}m travelled.`,
    };
  }

  const where = data?.stoppedAt
    ? `(${data.stoppedAt.x}, ${data.stoppedAt.y}, ${data.stoppedAt.z})`
    : "an unknown position";

  const blockers = Array.isArray(data?.blockedBy) && data.blockedBy.length > 0
    ? data.blockedBy.map((b: any) => `${b.name} (${b.hits}x)`).join(", ")
    : "nothing it could name";

  if (data?.startedInAir === true) {
    return {
      passed: false,
      verdict:
        `NOT walkable: there is no ground under the start position, so the walk never began. ` +
        `Nothing was standing there to walk.`,
      actionRequired:
        "Check the start position against the surface you expect it to be on — the y is " +
        "usually the mistake, or the surface is buried inside another collider.",
    };
  }

  return {
    passed: false,
    verdict:
      `NOT walkable: stopped at ${where} with ${data?.remainingDistance}m still to go ` +
      `(${data?.stopReason}). Obstructed by ${blockers}.`,
    actionRequired:
      "This route does not exist in the scene as built. Look at what is named above: geometry " +
      "placed inside other geometry is the usual cause, and it is invisible in a screenshot. " +
      "Fix the placement, rebuild, and run this probe again before reporting the level works.",
  };
}

export function overlapVerdict(data: any): { passed: boolean; verdict: string; actionRequired?: string } {
  const buried = Number(data?.buriedSurfaceCount ?? 0);
  const deep = Number(data?.deepOverlapCount ?? 0);

  if (buried === 0 && deep === 0) {
    return {
      passed: true,
      verdict: `Clean: ${data?.collidersChecked ?? 0} colliders, no buried surfaces, no deep overlaps.`,
    };
  }

  const parts: string[] = [];
  if (buried > 0) parts.push(`${buried} surface(s) with solid matter directly above them`);
  if (deep > 0) parts.push(`${deep} pair(s) interpenetrating past the depth threshold`);

  return {
    passed: false,
    verdict: `${parts.join(" and ")} out of ${data?.collidersChecked ?? 0} colliders checked.`,
    actionRequired:
      buried > 0
        ? "A buried surface cannot be stood on. If any of the names above is something the " +
          "player is meant to walk on — a step, a floor, a platform — it is inside another " +
          "object and the route across it does not exist. Confirm with unity_walk_probe. " +
          "Overlaps that are deliberate (a room carved into a rock mass) can be filtered with " +
          "ignoreNames."
        : "Deep interpenetration is usually a placement error: two objects were given the same " +
          "space. Harmless when deliberate — check the pairs before changing anything.",
  };
}

export function auditVerdict(data: any): { passed: boolean; verdict: string; actionRequired?: string } {
  const problems: string[] = [];

  if (Number(data?.enabledCameras ?? 0) === 0) problems.push("no enabled camera — the scene renders nothing");
  if (Number(data?.enabledCameras ?? 0) > 1) problems.push(`${data.enabledCameras} enabled cameras`);
  if (Number(data?.enabledLights ?? 0) === 0) problems.push("no enabled light");
  if ((data?.missingScripts ?? []).length > 0) problems.push(`${data.missingScripts.length} object(s) with a missing script reference`);
  if ((data?.invalidTransforms ?? []).length > 0) problems.push(`${data.invalidTransforms.length} object(s) with a NaN, infinite, absurd or zero-scale transform`);
  if ((data?.renderersWithNoMaterial ?? []).length > 0) problems.push(`${data.renderersWithNoMaterial.length} renderer(s) with no material`);

  const thin = (data?.thinColliders ?? []).length;

  if (problems.length === 0 && thin === 0) {
    return {
      passed: true,
      verdict: `${data?.scene}: ${data?.objects} objects, ${data?.enabledCameras} camera(s), ${data?.enabledLights} light(s), nothing structurally wrong.`,
    };
  }

  const verdict = problems.length > 0
    ? `${data?.scene}: ${problems.join("; ")}.`
    : `${data?.scene}: structurally fine, but ${thin} collider(s) are thin enough to be tunnelled.`;

  return {
    passed: problems.length === 0,
    verdict,
    actionRequired:
      thin > 0
        ? "Anything moving faster than (thinnest axis / fixedDeltaTime) passes straight through " +
          "a collider that thin — measured at 26 m/s against a 0.18m wall. Either thicken it, " +
          "set the mover's Rigidbody to ContinuousDynamic, or detect contact with a swept cast " +
          "rather than a trigger."
        : "Fix the structural problems above before judging anything else about the scene.",
  };
}

// ---------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------

export function registerUnityProbes(): void {
  localToolRegistry.register({
    name: "unity_walk_probe",
    description:
      "Prove a route exists in the open Unity scene: walk a capsule from one point to another " +
      "using the same collide, step-up and ground rules a CharacterController uses, and report " +
      "whether it arrived, where it stopped and what blocked it. Use this before claiming a " +
      "level works — stairs, platforms, ramps and doorways all look correct in a screenshot " +
      "while being impossible to traverse. Needs no play mode.",
    parameters: {
      type: "object",
      properties: {
        from: {
          type: "array",
          description: "Start position [x, y, z] — where the player stands.",
          items: { type: "number" },
        },
        to: {
          type: "array",
          description: "Target position [x, y, z] — where they should be able to get to.",
          items: { type: "number" },
        },
        via: {
          type: "array",
          description:
            "Optional waypoints between from and to, each [x, y, z], walked in order. Use " +
            "these for any route that is not a straight line — the foot of a stair, a " +
            "doorway, the top of a ramp. Without them a blocked result only means 'not in a " +
            "straight line', which is usually not the question.",
          items: { type: "array", items: { type: "number" } },
        },
        radius: { type: "number", description: "Capsule radius. Default 0.35." },
        height: { type: "number", description: "Capsule height. Default 1.8." },
        stepHeight: { type: "number", description: "Tallest step that can be climbed. Default 0.4." },
        stride: { type: "number", description: "Metres per simulated step. Default 0.35." },
        maxSteps: { type: "number", description: "Give up after this many steps. Default 600." },
        fallLimit: {
          type: "number",
          description: "A drop larger than this counts as no ground. Default 4.",
        },
        projectPath: { type: "string", description: "Unity project root. Defaults to the working directory." },
      },
      required: ["from", "to"],
    },
    handler: async (args) => {
      const project = resolveProject(args?.projectPath);
      if ("error" in project) return project.error;

      const from = Array.isArray(args?.from) ? args.from.map(Number) : [];
      const to = Array.isArray(args?.to) ? args.to.map(Number) : [];

      if (from.length !== 3 || to.length !== 3 || [...from, ...to].some((n) => !Number.isFinite(n))) {
        return {
          error: true,
          message: "from and to must each be three finite numbers: [x, y, z].",
          actionRequired: 'Call again like {"from":[0,8,-50],"to":[0,40,0]}.',
        };
      }

      const via: Array<[number, number, number]> = Array.isArray(args?.via)
        ? args.via
            .map((point: any) => (Array.isArray(point) ? point.map(Number) : []))
            .filter((point: number[]) => point.length === 3 && point.every((n) => Number.isFinite(n)))
            .map((point: number[]) => point as [number, number, number])
        : [];

      const outcome = evalInEditor(
        project.root,
        walkProbePayload({
          from: from as [number, number, number],
          route: [...via, to as [number, number, number]],
          radius: Number(args?.radius) || 0.35,
          height: Number(args?.height) || 1.8,
          stepHeight: Number(args?.stepHeight) || 0.4,
          stride: Number(args?.stride) || 0.35,
          maxSteps: Number(args?.maxSteps) || 600,
          fallLimit: Number(args?.fallLimit) || 4,
        })
      );

      if (!outcome.ok) {
        return {
          error: true,
          message: `The walk probe could not run: ${outcome.error}`,
          actionRequired:
            "The Editor must be open on this project with the pipeline package installed. " +
            "Check with editor_status, then try again.",
        };
      }

      return { ...outcome.data, ...walkVerdict(outcome.data) };
    },
  });

  localToolRegistry.register({
    name: "unity_scene_overlaps",
    description:
      "Find geometry in the open Unity scene that occupies the same space as other geometry: " +
      "surfaces with solid matter directly above them (a step or floor built inside another " +
      "object, which cannot be stood on) and colliders interpenetrating past a depth " +
      "threshold. Catches the class of mistake that compiles, saves and screenshots perfectly.",
    parameters: {
      type: "object",
      properties: {
        minDepth: {
          type: "number",
          description: "Report interpenetration deeper than this, in metres. Default 0.05.",
        },
        maxPairs: { type: "number", description: "Cap on reported items per category. Default 25." },
        ignoreNames: {
          type: "array",
          description:
            "Skip objects whose name contains any of these (case-insensitive) — for overlaps " +
            "that are deliberate, like a suite carved into a rock mass.",
          items: { type: "string" },
        },
        projectPath: { type: "string", description: "Unity project root. Defaults to the working directory." },
      },
      required: [],
    },
    handler: async (args) => {
      const project = resolveProject(args?.projectPath);
      if ("error" in project) return project.error;

      const outcome = evalInEditor(
        project.root,
        overlapProbePayload({
          minDepth: Number(args?.minDepth) || 0.05,
          maxPairs: Number(args?.maxPairs) || 25,
          ignoreNames: Array.isArray(args?.ignoreNames)
            ? args.ignoreNames.filter((n: any) => typeof n === "string" && n.trim()).slice(0, 20)
            : [],
        })
      );

      if (!outcome.ok) {
        return {
          error: true,
          message: `The overlap probe could not run: ${outcome.error}`,
          actionRequired: "Check the Editor is open on this project with editor_status, then retry.",
        };
      }

      return { ...outcome.data, ...overlapVerdict(outcome.data) };
    },
  });

  localToolRegistry.register({
    name: "unity_scene_audit",
    description:
      "Structural sanity check on the open Unity scene: enabled cameras and lights, missing " +
      "script references, NaN or absurd transforms, renderers with no material, and colliders " +
      "thin enough for a fast mover to tunnel through. Cheap, and worth running after any " +
      "generated scene build.",
    parameters: {
      type: "object",
      properties: {
        thinThreshold: {
          type: "number",
          description: "Flag colliders thinner than this on any axis, in metres. Default 0.1.",
        },
        maxItems: { type: "number", description: "Cap on names reported per category. Default 25." },
        projectPath: { type: "string", description: "Unity project root. Defaults to the working directory." },
      },
      required: [],
    },
    handler: async (args) => {
      const project = resolveProject(args?.projectPath);
      if ("error" in project) return project.error;

      const outcome = evalInEditor(
        project.root,
        auditProbePayload({
          thinThreshold: Number(args?.thinThreshold) || 0.1,
          maxItems: Number(args?.maxItems) || 25,
        })
      );

      if (!outcome.ok) {
        return {
          error: true,
          message: `The scene audit could not run: ${outcome.error}`,
          actionRequired: "Check the Editor is open on this project with editor_status, then retry.",
        };
      }

      return { ...outcome.data, ...auditVerdict(outcome.data) };
    },
  });
}
