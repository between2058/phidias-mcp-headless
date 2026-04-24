/**
 * Parse a USDA (text) stage containing UsdPhysics schemas into the
 * `phidias.physics.v1` JSON shape consumed by the Phidias frontend
 * Physics Editor's "Import Config" button.
 *
 * This is a pure TypeScript port of scripts/usdz_to_phidias_physics.py
 * (the Python equivalent, now removed), eliminating the runtime dependency
 * on `python3` and `usdcat`. Upstream calls `/api/export-usda` on the
 * articulation-service to get text USDA rather than parsing a binary
 * `.usdc` out of a USDZ.
 */

const AXIS_MAP: Record<string, [number, number, number]> = {
  X: [1, 0, 0],
  Y: [0, 1, 0],
  Z: [0, 0, 1],
};

type PhidiasJointType = 'Revolute' | 'Prismatic' | 'Fixed' | 'Spherical';

const JOINT_TYPE_MAP: Record<string, PhidiasJointType> = {
  PhysicsRevoluteJoint: 'Revolute',
  PhysicsPrismaticJoint: 'Prismatic',
  PhysicsFixedJoint: 'Fixed',
  PhysicsSphericalJoint: 'Spherical',
};

const PALETTE = [
  '#7c3aed', '#f5a623', '#2dd4bf', '#f43f5e', '#fbbf24',
  '#60a5fa', '#a78bfa', '#34d399', '#fb7185', '#fcd34d',
  '#38bdf8', '#c084fc', '#4ade80', '#f87171', '#facc15',
  '#9333ea', '#ea580c', '#0d9488', '#be123c', '#d97706',
];

function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countChar(s: string, ch: '{' | '}'): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
  return n;
}

interface Block { header: string; body: string; }

function* findBlocks(
  text: string,
  defPattern: string,
  indent: number,
): Generator<Block> {
  const lines = text.split('\n');
  // Header may span multiple lines (apiSchemas on separate line inside parens),
  // so collect from `def` line up to—but not including—the `{` that opens the block.
  const headerRe = new RegExp(`^ {${indent}}def ${defPattern}(?=\\s|$)`);
  let i = 0;
  while (i < lines.length) {
    if (headerRe.test(lines[i])) {
      const headerStart = i;
      let j = i;
      while (j < lines.length && !lines[j].includes('{')) j++;
      if (j >= lines.length) break;
      const header = lines.slice(headerStart, j).join('\n');
      // Brace-depth scan so nested Mesh / Shader blocks don't prematurely close.
      const bodyLines: string[] = [];
      let depth = countChar(lines[j], '{') - countChar(lines[j], '}');
      let k = j + 1;
      while (k < lines.length && depth > 0) {
        depth += countChar(lines[k], '{') - countChar(lines[k], '}');
        if (depth > 0) bodyLines.push(lines[k]);
        k++;
      }
      yield { header, body: bodyLines.join('\n') };
      i = k;
    } else {
      i++;
    }
  }
}

function readFloat(body: string, key: string, def: number): number {
  const m = body.match(
    new RegExp(`${reEscape(key)}\\s*=\\s*(-?[\\d.eE+\\-]+)`),
  );
  return m ? parseFloat(m[1]) : def;
}

function readString(body: string, key: string): string | null {
  const m = body.match(new RegExp(`${reEscape(key)}\\s*=\\s*"([^"]+)"`));
  return m ? m[1] : null;
}

function readPoint3(
  body: string,
  key: string,
  def: [number, number, number],
): [number, number, number] {
  const m = body.match(
    new RegExp(
      `${reEscape(key)}\\s*=\\s*\\((-?[\\d.eE+\\-]+)\\s*,\\s*(-?[\\d.eE+\\-]+)\\s*,\\s*(-?[\\d.eE+\\-]+)\\)`,
    ),
  );
  if (!m) return def;
  return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
}

function readRelTail(body: string, key: string): string | null {
  const m = body.match(new RegExp(`${reEscape(key)}\\s*=\\s*<([^>]+)>`));
  if (!m) return null;
  const tail = m[1].replace(/\/+$/, '').split('/').pop();
  return tail ?? null;
}

function headerName(header: string): string {
  const m = header.match(/"([^"]+)"/);
  return m ? m[1] : '';
}

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

export interface PhysicsPart {
  id: string;
  name: string;
  color: string;
  type: 'base' | 'link';
  role: 'other';
  mobility: 'fixed' | 'revolute' | 'prismatic';
  mass: number | null;
  density: number;
  collisionType: string;
  staticFriction: number;
  dynamicFriction: number;
  restitution: number;
  materialId: null;
  isMaterialCustom: true;
  originalMaterial: null;
  vertexCount: number;
}

export interface PhysicsJoint {
  id: string;
  name: string;
  type: PhidiasJointType;
  parentPartId: string;
  childPartId: string;
  axis: [number, number, number];
  anchor: [number, number, number];
  limitsEnabled: boolean;
  limitLower: number;
  limitUpper: number;
  driveStiffness: number;
  driveDamping: number;
  driveMaxForce: number;
  driveType: 'position' | 'none';
  disableCollision: boolean;
}

export interface PhysicsJson {
  schema: 'phidias.physics.v1';
  source: string;
  baseId: string | null;
  parts: PhysicsPart[];
  joints: PhysicsJoint[];
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

interface MaterialInfo {
  staticFriction: number;
  dynamicFriction: number;
  restitution: number;
}

function parseMaterials(text: string): Record<string, MaterialInfo> {
  const mats: Record<string, MaterialInfo> = {};
  for (const { header, body } of findBlocks(text, 'Material "[^"]+"', 8)) {
    if (!header.includes('PhysicsMaterialAPI')) continue;
    const name = headerName(header);
    mats[name] = {
      staticFriction: readFloat(body, 'physics:staticFriction', 0.5),
      dynamicFriction: readFloat(body, 'physics:dynamicFriction', 0.3),
      restitution: readFloat(body, 'physics:restitution', 0.1),
    };
  }
  return mats;
}

function parseParts(
  text: string,
  materials: Record<string, MaterialInfo>,
  baseId: string | null,
): PhysicsPart[] {
  const parts: PhysicsPart[] = [];
  let idx = 0;
  for (const { header, body } of findBlocks(text, 'Xform "[^"]+"', 4)) {
    if (!header.includes('PhysicsRigidBodyAPI')) continue;
    const name = headerName(header);

    const density = readFloat(body, 'physics:density', 1000);
    const massVal = readFloat(body, 'physics:mass', -1);
    const mass = massVal > 0 ? massVal : null;

    // Find the inner Mesh block (indent=8) for collision + material binding.
    let collisionType = 'convexHull';
    let matName: string | null = null;
    for (const { header: mhdr, body: mbody } of findBlocks(body, 'Mesh "[^"]+"', 8)) {
      if (mhdr.includes('PhysicsCollisionAPI')) {
        const approx = readString(mbody, 'physics:approximation') ?? 'convexHull';
        if (
          approx === 'convexHull' ||
          approx === 'mesh' ||
          approx === 'convexDecomposition' ||
          approx === 'none'
        ) {
          collisionType = approx;
        }
      }
      const binding = readRelTail(mbody, 'rel material:binding');
      if (binding) matName = binding;
      break;
    }

    const mat =
      (matName ? materials[matName] : undefined) ??
      { staticFriction: 0.5, dynamicFriction: 0.3, restitution: 0.1 };

    parts.push({
      id: name,
      name,
      color: PALETTE[idx % PALETTE.length],
      type: name === baseId ? 'base' : 'link',
      role: 'other',
      mobility: 'fixed', // refined in a second pass after joints
      mass,
      density,
      collisionType,
      staticFriction: mat.staticFriction,
      dynamicFriction: mat.dynamicFriction,
      restitution: mat.restitution,
      materialId: null,
      isMaterialCustom: true,
      originalMaterial: null,
      vertexCount: 0,
    });
    idx++;
  }
  return parts;
}

function parseJoints(text: string): PhysicsJoint[] {
  const joints: PhysicsJoint[] = [];
  for (const [primType, phidiasType] of Object.entries(JOINT_TYPE_MAP)) {
    // Joints live under def Xform "Joints" { ... } at indent=4;
    // the individual joint prims are at indent=8.
    const pattern = `${primType} "[^"]+"`;
    for (const { header, body } of findBlocks(text, pattern, 8)) {
      const name = headerName(header);
      const parent = readRelTail(body, 'rel physics:body0') ?? '';
      const child = readRelTail(body, 'rel physics:body1') ?? '';
      const axisTok = readString(body, 'uniform token physics:axis') ?? 'X';
      const axis = AXIS_MAP[axisTok] ?? [1, 0, 0];
      const anchor = readPoint3(body, 'point3f physics:localPos0', [0, 0, 0]);
      const lower = readFloat(body, 'float physics:lowerLimit', NaN);
      const upper = readFloat(body, 'float physics:upperLimit', NaN);
      const hasLimits = !Number.isNaN(lower) && !Number.isNaN(upper);
      const drivePfx =
        phidiasType === 'Revolute'
          ? 'drive:angular:physics:'
          : 'drive:linear:physics:';
      const stiffness = readFloat(body, `float ${drivePfx}stiffness`, 0);
      const damping = readFloat(body, `float ${drivePfx}damping`, 0);
      const maxForce = readFloat(body, `float ${drivePfx}maxForce`, 0);
      const driveTypeTok = readString(body, `uniform token ${drivePfx}type`);
      const driveType: 'position' | 'none' =
        driveTypeTok === 'force' || driveTypeTok === 'acceleration'
          ? 'position'
          : 'none';

      joints.push({
        id: name,
        name,
        type: phidiasType,
        parentPartId: parent,
        childPartId: child,
        axis,
        anchor,
        limitsEnabled: hasLimits,
        limitLower: hasLimits ? lower : phidiasType === 'Revolute' ? -45 : -0.1,
        limitUpper: hasLimits ? upper : phidiasType === 'Revolute' ? 45 : 0.1,
        driveStiffness: stiffness,
        driveDamping: damping,
        driveMaxForce: maxForce,
        driveType,
        disableCollision: true,
      });
    }
  }
  return joints;
}

function refinePartMobility(parts: PhysicsPart[], joints: PhysicsJoint[]): void {
  const mobilityByChild = new Map<string, 'revolute' | 'prismatic' | 'fixed'>();
  for (const j of joints) {
    if (j.type === 'Revolute') mobilityByChild.set(j.childPartId, 'revolute');
    else if (j.type === 'Prismatic') mobilityByChild.set(j.childPartId, 'prismatic');
    else if (!mobilityByChild.has(j.childPartId)) mobilityByChild.set(j.childPartId, 'fixed');
  }
  for (const p of parts) {
    const m = mobilityByChild.get(p.id);
    if (m) p.mobility = m;
  }
}

function inferBaseId(text: string): string | null {
  const counts = new Map<string, number>();
  const re = /rel physics:body0\s*=\s*<([^>]+)>/g;
  for (const m of text.matchAll(re)) {
    const name = m[1].replace(/\/+$/, '').split('/').pop() ?? '';
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let best: string | null = null;
  let bestCount = -1;
  for (const [k, v] of counts) {
    if (v > bestCount) {
      best = k;
      bestCount = v;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export function parseUsdaToPhysics(usdaText: string, source: string): PhysicsJson {
  const baseId = inferBaseId(usdaText);
  const materials = parseMaterials(usdaText);
  const parts = parseParts(usdaText, materials, baseId);
  const joints = parseJoints(usdaText);
  refinePartMobility(parts, joints);
  return {
    schema: 'phidias.physics.v1',
    source,
    baseId,
    parts,
    joints,
  };
}
