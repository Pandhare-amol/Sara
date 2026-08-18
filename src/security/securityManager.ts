import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { generateIntegrityManifest, loadIntegrityManifest, verifyIntegrity, IntegrityManifest } from './integrityMonitor';
import { gatherBuildIdentity, loadBuildManifest, BuildIdentity } from './buildIdentity';
import { AuditLogger, AuditEvent } from './auditLogger';
import { execSync } from 'child_process';
import { appendAuditEvent } from '../../server_state';

export type ChangeClassification = 'EXPECTED_UPDATE'|'DEVELOPER_CHANGE'|'CONFIG_CHANGE'|'UNKNOWN_CHANGE'|'POSSIBLE_TAMPERING';

export interface FileChange { file: string; expected?: string; actual?: string; ok: boolean; classification?: ChangeClassification }

export class SecurityManager {
  dataDir: string;
  projectRoot: string;
  audit: AuditLogger;
  trustedManifestPath: string;
  generatedManifestPath: string;
  protectedPaths: string[];

  constructor(projectRoot: string, dataDir: string, protectedPaths: string[] = []){
    this.projectRoot = projectRoot;
    this.dataDir = dataDir;
    this.audit = new AuditLogger(path.join(this.dataDir,'logs'));
    this.trustedManifestPath = path.join(this.dataDir,'integrity','trusted-manifest.json');
    this.generatedManifestPath = path.join(this.dataDir,'integrity','generated-manifest.json');
    this.protectedPaths = protectedPaths.length?protectedPaths:['src','desktop_agent','server_full.ts','package.json'];
  }

  loadTrustedManifest(): IntegrityManifest | null {
    try { if (fs.existsSync(this.trustedManifestPath)) return JSON.parse(fs.readFileSync(this.trustedManifestPath,'utf8')); } catch {}
    return null;
  }

  saveTrustedManifest(man: IntegrityManifest){
    try { fs.mkdirSync(path.dirname(this.trustedManifestPath), { recursive: true }); fs.writeFileSync(this.trustedManifestPath, JSON.stringify(man, null, 2)); } catch(e){}
  }

  generateBaseline(sourceRev?: string){
    const out = this.generatedManifestPath;
    const man = generateIntegrityManifest(this.projectRoot, this.protectedPaths, out, sourceRev);
    return man;
  }

  verifyAgainst(man: IntegrityManifest | null){
    if (!man) return [] as FileChange[];
    const res = verifyIntegrity(this.projectRoot, man);
    return res.map(r => ({ file: r.file, expected: r.expected, actual: r.actual, ok: r.ok }));
  }

  classifyChanges(changes: FileChange[]): FileChange[]{
    // Use git status to determine if files are tracked/modified
    let gitAvailable = true;
    try { execSync('git rev-parse --is-inside-work-tree', { cwd: this.projectRoot, stdio: ['ignore','ignore','ignore'] }); } catch { gitAvailable = false; }
    const gitStatusMap: Record<string,string> = {};
    if (gitAvailable){
      try {
        const out = execSync('git status --porcelain --untracked-files=all', { cwd: this.projectRoot }).toString('utf8');
        out.split('\n').forEach(line => { if (!line) return; const status = line.slice(0,2).trim(); const fp = line.slice(3).trim(); gitStatusMap[fp] = status; });
      } catch {}
    }
    return changes.map(c => {
      const rel = c.file;
      let cls: ChangeClassification = 'UNKNOWN_CHANGE';
      if (c.ok) cls = 'EXPECTED_UPDATE';
      else if (gitAvailable && gitStatusMap[rel]) cls = 'DEVELOPER_CHANGE';
      else if (rel.endsWith('.json') || rel.includes('config') || rel.includes('settings')) cls = 'CONFIG_CHANGE';
      else cls = 'POSSIBLE_TAMPERING';
      return { ...c, classification: cls };
    });
  }

  async startupVerify(){
    try {
      const build = gatherBuildIdentity(this.projectRoot, this.dataDir);
      const generated = loadIntegrityManifest(this.generatedManifestPath) || this.generateBaseline(build.source_revision);
      const trusted = this.loadTrustedManifest();
      const results = this.verifyAgainst(trusted || generated);
      const classified = this.classifyChanges(results);
      const anyFail = classified.some(c => !c.ok && c.classification !== 'EXPECTED_UPDATE');
      // emit audit event
      try { await appendAuditEvent({ event_type: 'CODE_INTEGRITY_CHECK', metadata: { build, results: classified }, severity: anyFail? 'WARNING':'INFO' }); } catch {}
      return { build, generated, trusted, results: classified, status: anyFail? 'WARNING':'TRUSTED' };
    } catch (e) {
      try { await appendAuditEvent({ event_type: 'CODE_INTEGRITY_ERROR', metadata: { error: String(e) }, severity: 'HIGH' }); } catch {}
      return { error: String(e) };
    }
  }

  approveTrustedBaseline(){
    const gen = loadIntegrityManifest(this.generatedManifestPath);
    if (!gen) return false;
    this.saveTrustedManifest(gen);
    // record audit
    appendAuditEvent({ event_type: 'TRUSTED_BASELINE_APPROVED', metadata: { source_revision: gen.source_revision } }).catch(()=>{});
    return true;
  }
}

export default SecurityManager;
