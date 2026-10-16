export type PrimitiveShape = "cube" | "sphere" | "cylinder";
export interface PrimitiveDimensions { width: number; height: number; depth: number }
export function createPrimitiveObj(shape: PrimitiveShape, dimensions: PrimitiveDimensions): Buffer {
  if (!["cube", "sphere", "cylinder"].includes(shape) || !dimensions ||
      [dimensions.width, dimensions.height, dimensions.depth].some((value) =>
        typeof value !== "number" || !Number.isFinite(value) || value < 0.1 || value > 10)) {
    throw new Error("Choose a primitive shape with 0.1–10 metre dimensions.");
  }
  const { width, height, depth } = dimensions;
  const points: Array<[number, number, number]> = [];
  const triangles: Array<[number, number, number]> = [];
  const add = (x: number, y: number, z: number) => { points.push([x, y, z]); return points.length; };
  const quad = (a: number, b: number, c: number, d: number) => { triangles.push([a, b, c], [a, c, d]); };
  if (shape === "cube") {
    for (const z of [-depth / 2, depth / 2]) for (const y of [-height / 2, height / 2]) for (const x of [-width / 2, width / 2]) add(x, y, z);
    // Bottom, top and four walls; all faces are indexed triangles.
    quad(1, 3, 4, 2); quad(5, 6, 8, 7); quad(1, 5, 7, 3);
    quad(2, 4, 8, 6); quad(1, 2, 6, 5); quad(3, 7, 8, 4);
  } else if (shape === "sphere") {
    const longitude = 24, latitude = 16;
    const top = add(0, 0, depth / 2);
    for (let lat = 1; lat < latitude; lat++) {
      const theta = Math.PI * lat / latitude;
      for (let lon = 0; lon < longitude; lon++) {
        const phi = 2 * Math.PI * lon / longitude;
        add(width / 2 * Math.sin(theta) * Math.cos(phi), height / 2 * Math.sin(theta) * Math.sin(phi), depth / 2 * Math.cos(theta));
      }
    }
    const bottom = add(0, 0, -depth / 2);
    const ring = (lat: number, lon: number) => 2 + (lat - 1) * longitude + (lon + longitude) % longitude;
    for (let lon = 0; lon < longitude; lon++) {
      triangles.push([top, ring(1, lon), ring(1, lon + 1)]);
      for (let lat = 1; lat < latitude - 1; lat++) {
        quad(ring(lat, lon), ring(lat + 1, lon), ring(lat + 1, lon + 1), ring(lat, lon + 1));
      }
      triangles.push([bottom, ring(latitude - 1, lon + 1), ring(latitude - 1, lon)]);
    }
  } else {
    const sides = 24;
    const bottomCenter = add(0, 0, -depth / 2), topCenter = add(0, 0, depth / 2);
    for (let side = 0; side < sides; side++) {
      const angle = 2 * Math.PI * side / sides;
      add(width / 2 * Math.cos(angle), height / 2 * Math.sin(angle), -depth / 2);
      add(width / 2 * Math.cos(angle), height / 2 * Math.sin(angle), depth / 2);
    }
    for (let side = 0; side < sides; side++) {
      const b = 3 + 2 * side, t = b + 1, nextB = 3 + 2 * (side + 1) % (2 * sides), nextT = nextB + 1;
      quad(b, nextB, nextT, t);
      triangles.push([bottomCenter, nextB, b], [topCenter, t, nextT]);
    }
  }
  return Buffer.from(["# SARA local parametric geometry; no materials, textures or rigging",
    `o SARA_${shape}`, ...points.map((coords) => `v ${coords.map((value) => value.toFixed(6)).join(" ")}`),
    ...triangles.map((face) => `f ${face.join(" ")}`), ""].join("\n"), "utf8");
}

/** Re-parse the written OBJ as data. This verifies topology, not render quality. */
export function inspectPrimitiveObj(bytes: Buffer): { vertices: number; triangles: number } {
  if (!bytes.length || bytes.length > 250_000) throw new Error("OBJ exceeds the approved geometry budget.");
  const lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes).split(/\r?\n/);
  const vertices: Array<[number, number, number]> = [];
  const faces: Array<[number, number, number]> = [];
  const edges = new Map<string, number>();
  for (const line of lines) {
    if (!line || line.startsWith("#") || /^o [a-zA-Z0-9_]+$/.test(line)) continue;
    if (line.startsWith("v ")) {
      const parsed = line.slice(2).trim().split(/\s+/).map(Number);
      if (parsed.length !== 3 || parsed.some((value) => !Number.isFinite(value) || Math.abs(value) > 10)) throw new Error("OBJ vertex is invalid.");
      vertices.push(parsed as [number, number, number]);
      if (vertices.length > 1_000) throw new Error("OBJ has too many vertices.");
    } else if (line.startsWith("f ")) {
      const parts = line.slice(2).trim().split(/\s+/);
      if (parts.length !== 3 || parts.some((part) => !/^[1-9]\d*$/.test(part))) throw new Error("OBJ requires indexed triangular faces.");
      const face = parts.map(Number) as [number, number, number];
      if (new Set(face).size !== 3 || face.some((index) => index > vertices.length)) throw new Error("OBJ face index is invalid.");
      faces.push(face); if (faces.length > 2_000) throw new Error("OBJ has too many faces.");
      const [a, b, c] = face.map((index) => vertices[index - 1]);
      const cross = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
        (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])];
      const outward = cross.reduce((total, value, axis) => total + value * (a[axis] + b[axis] + c[axis]) / 3, 0);
      if (outward <= 1e-8) throw new Error("OBJ includes degenerate or inward-facing triangles.");
      for (const [from, to] of [[face[0], face[1]], [face[1], face[2]], [face[2], face[0]]]) {
        const edge = `${Math.min(from, to)}-${Math.max(from, to)}`;
        edges.set(edge, (edges.get(edge) || 0) + 1);
      }
    } else throw new Error("Unsupported OBJ instruction.");
  }
  if (vertices.length < 4 || faces.length < 4 || [...edges.values()].some((count) => count !== 2)) {
    throw new Error("OBJ is not a closed triangular mesh.");
  }
  return { vertices: vertices.length, triangles: faces.length };
}
