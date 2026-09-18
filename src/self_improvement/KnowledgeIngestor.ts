// src/self_improvement/KnowledgeIngestor.ts
import fs from "node:fs";
import path from "node:path";
import initSqlJs from "sql.js";

export interface Article {
  title: string;
  abstract: string;
  source: string;
  fetchedAt: string;
}

/** Simple SQLite-backed knowledge store */
export class KnowledgeIngestor {
  private dbPath: string;
  private db: any; // sqlite Database instance
  private persist: (() => void) | null = null;

  constructor(dbPath: string = "data/knowledge.db") {
    this.dbPath = dbPath;
  }

  /** Initialize the DB and tables */
  async init(): Promise<void> {
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(process.cwd(), "node_modules", "sql.js", "dist", file),
    });
    fs.mkdirSync(path.dirname(path.resolve(this.dbPath)), { recursive: true });
    this.db = fs.existsSync(this.dbPath)
      ? new SQL.Database(new Uint8Array(fs.readFileSync(this.dbPath)))
      : new SQL.Database();
    this.db.run(`
      CREATE TABLE IF NOT EXISTS articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        abstract TEXT NOT NULL,
        source TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );
    `);
    this.persist = () => {
      fs.writeFileSync(this.dbPath, Buffer.from(this.db.export()));
    };
    this.persist();
  }

  async storeArticle(article: Article): Promise<void> {
    if (!this.db) await this.init();
    const { title, abstract, source, fetchedAt } = article;
    this.db.run(
      `INSERT INTO articles (title, abstract, source, fetched_at) VALUES (?, ?, ?, ?);`,
      [title, abstract, source, fetchedAt],
    );
    this.persist?.();
  }

  async queryKnowledge(keyword: string): Promise<Article[]> {
    if (!this.db) await this.init();
    const statement = this.db.prepare(
      `SELECT title, abstract, source, fetched_at as fetchedAt FROM articles WHERE title LIKE ? OR abstract LIKE ?;`,
    );
    statement.bind([`%${keyword}%`, `%${keyword}%`]);
    const rows: Article[] = [];
    while (statement.step()) rows.push(statement.getAsObject() as Article);
    statement.free();
    return rows;
  }
}
