// src/self_improvement/GraphStore.ts

/**
 * Minimal wrapper around a Neo4j‑style in‑memory graph for storing concepts,
 * bug patterns and their relationships. In a real deployment you would replace
 * this with a proper Neo4j driver, but the interface mirrors the typical CRUD
 * operations needed by the self‑improvement engine.
 */

type NodeId = string;

type RelationshipType = string;

interface Node {
  id: NodeId;
  labels: string[];
  properties: Record<string, unknown>;
}

interface Relationship {
  id: string;
  type: RelationshipType;
  from: NodeId;
  to: NodeId;
  properties: Record<string, unknown>;
}

export class GraphStore {
  private nodes = new Map<NodeId, Node>();
  private relationships = new Map<string, Relationship>();

  /** Create or update a node. */
  upsertNode(id: NodeId, labels: string[] = [], properties: Record<string, unknown> = {}): Node {
    const existing = this.nodes.get(id);
    if (existing) {
      existing.labels = Array.from(new Set([...existing.labels, ...labels]));
      existing.properties = { ...existing.properties, ...properties };
      return existing;
    }
    const node: Node = { id, labels, properties };
    this.nodes.set(id, node);
    return node;
  }

  /** Create a relationship between two nodes. */
  createRelationship(type: RelationshipType, from: NodeId, to: NodeId, properties: Record<string, unknown> = {}): Relationship {
    const relId = `${from}-${type}-${to}`;
    const rel: Relationship = { id: relId, type, from, to, properties };
    this.relationships.set(relId, rel);
    return rel;
  }

  /** Find nodes by label and optional property filter. */
  findNodes(label: string, filter?: Partial<Record<string, unknown>>): Node[] {
    const result: Node[] = [];
    for (const node of this.nodes.values()) {
      if (!node.labels.includes(label)) continue;
      if (filter) {
        const matches = Object.entries(filter).every(([k, v]) => node.properties[k] === v);
        if (!matches) continue;
      }
      result.push(node);
    }
    return result;
  }

  /** Simple traversal: get outgoing relationships of a given type from a node. */
  outgoing(nodeId: NodeId, type?: RelationshipType): Relationship[] {
    const rels: Relationship[] = [];
    for (const rel of this.relationships.values()) {
      if (rel.from === nodeId && (!type || rel.type === type)) {
        rels.push(rel);
      }
    }
    return rels;
  }
}
