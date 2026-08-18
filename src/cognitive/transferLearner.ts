/**
 * Transfer Learning Framework
 * 
 * Enables knowledge transfer between different projects and domains:
 * - Extract generalizable skills from one project
 * - Apply learned patterns to new projects
 * - Cross-domain knowledge sharing
 * - Skill proficiency tracking
 * - Success rate improvement through transfer
 * 
 * Use cases:
 * - New projects benefit from solutions to similar problems in past projects
 * - Common patterns automatically applied across projects
 * - Skills learned in one domain improve performance in related domains
 * - Cumulative learning across the entire system
 */

import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

export interface TransferableSkill {
  id: string;
  name: string;
  description: string;
  sourceProject: string;
  sourceEpisodes: string[];         // Episodes where this skill was learned
  applicableDomains: string[];      // Domains where this skill applies
  successRate: number;              // 0-1
  transferCount: number;            // How many times successfully transferred
  proficiency: number;              // 0-1, improves with use
  lastUsed: number;                 // Timestamp
  patterns: Record<string, unknown>; // Skill-specific patterns/rules
  timestamp: number;
}

export interface ProjectContext {
  projectId: string;
  name: string;
  domain: string;
  description: string;
  relatedProjects: string[];        // Similar projects
  skills: TransferableSkill[];      // Skills used in this project
  timestamp: number;
  episodeCount: number;
}

export interface DomainProfile {
  domain: string;
  description: string;
  relatedDomains: string[];
  commonSkills: string[];           // Skill IDs common to this domain
  successRateBoost: number;          // How much transfer helps
  timestamp: number;
}

export interface SkillApplication {
  skillId: string;
  sourceProject: string;
  targetProject: string;
  successRate: number;
  applicability: number;            // 0-1, how well it applies
  adaptations: Record<string, unknown>; // Changes made for new context
  timestamp: number;
}

/**
 * Manages transfer learning across projects
 */
export class TransferLearner {
  private skills: Map<string, TransferableSkill> = new Map();
  private projects: Map<string, ProjectContext> = new Map();
  private domains: Map<string, DomainProfile> = new Map();
  private skillApplications: SkillApplication[] = [];
  private dataPath: string;

  // Domain similarity matrix (for finding related domains)
  private domainSimilarity: Map<string, Map<string, number>> = new Map();

  constructor(dataPath: string = './data') {
    this.dataPath = dataPath;
    this.loadTransferData();
    this.initializeDomains();
  }

  /**
   * Register a new project context
   */
  registerProject(
    projectId: string,
    name: string,
    domain: string,
    description: string
  ): void {
    const project: ProjectContext = {
      projectId,
      name,
      domain,
      description,
      relatedProjects: [],
      skills: [],
      timestamp: Date.now(),
      episodeCount: 0,
    };

    // Find related projects in same domain
    this.projects.forEach((p) => {
      if (p.domain === domain && p.projectId !== projectId) {
        project.relatedProjects.push(p.projectId);
      }
    });

    this.projects.set(projectId, project);
    this.persistProjectRegistry();
  }

  /**
   * Extract a skill from a project's episodes
   */
  extractSkill(
    projectId: string,
    episodeIds: string[],
    skillName: string,
    successRate: number,
    patterns: Record<string, unknown>
  ): TransferableSkill {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not registered`);
    }

    const skillId = uuidv4();
    const skill: TransferableSkill = {
      id: skillId,
      name: skillName,
      description: `Skill "${skillName}" extracted from ${project.name}`,
      sourceProject: projectId,
      sourceEpisodes: episodeIds,
      applicableDomains: [project.domain],
      successRate,
      transferCount: 0,
      proficiency: successRate, // Initial proficiency based on success rate
      lastUsed: 0,
      patterns,
      timestamp: Date.now(),
    };

    this.skills.set(skillId, skill);
    project.skills.push(skill);

    // Register with domain
    const domain = this.domains.get(project.domain);
    if (domain) {
      domain.commonSkills.push(skillId);
    }

    this.persistSkills();
    return skill;
  }

  /**
   * Find skills applicable to a new project
   */
  findApplicableSkills(
    projectId: string,
    maxResults: number = 10
  ): TransferableSkill[] {
    const project = this.projects.get(projectId);
    if (!project) return [];

    const candidates: Array<{ skill: TransferableSkill; score: number }> = [];

    this.skills.forEach((skill) => {
      // Don't transfer from same project
      if (skill.sourceProject === projectId) return;

      let score = 0;

      // Same domain: high score
      if (skill.applicableDomains.includes(project.domain)) {
        score += 0.8 * skill.proficiency * skill.successRate;
      }

      // Related domain: medium score
      const relatedDomains = this.domains.get(project.domain)?.relatedDomains || [];
      if (
        skill.applicableDomains.some((d) => relatedDomains.includes(d))
      ) {
        score += 0.5 * skill.proficiency * skill.successRate;
      }

      // Source project is related: bonus
      if (project.relatedProjects.includes(skill.sourceProject)) {
        score += 0.2;
      }

      if (score > 0) {
        candidates.push({ skill, score });
      }
    });

    // Sort by score and return top N
    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, maxResults).map((c) => c.skill);
  }

  /**
   * Apply a skill to a new project
   */
  applySkill(
    skillId: string,
    targetProjectId: string,
    adaptations?: Record<string, unknown>
  ): SkillApplication {
    const skill = this.skills.get(skillId);
    const targetProject = this.projects.get(targetProjectId);

    if (!skill || !targetProject) {
      throw new Error('Invalid skill or project');
    }

    // Calculate applicability
    const sameProject = skill.sourceProject === targetProjectId;
    const sameDomain = skill.applicableDomains.includes(targetProject.domain);
    const relatedDomain = this.isRelatedDomain(
      skill.applicableDomains[0],
      targetProject.domain
    );

    let applicability = 0;
    if (sameProject) {
      applicability = 0.95;
    } else if (sameDomain) {
      applicability = 0.8;
    } else if (relatedDomain) {
      applicability = 0.5;
    } else {
      applicability = 0.2;
    }

    const application: SkillApplication = {
      skillId,
      sourceProject: skill.sourceProject,
      targetProject: targetProjectId,
      successRate: skill.successRate * applicability,
      applicability,
      adaptations: adaptations || {},
      timestamp: Date.now(),
    };

    this.skillApplications.push(application);

    // Update skill transfer count
    skill.transferCount++;
    skill.lastUsed = Date.now();

    return application;
  }

  /**
   * Record success/failure of transferred skill
   */
  recordTransferOutcome(
    applicationId: number,
    success: boolean
  ): void {
    if (applicationId < 0 || applicationId >= this.skillApplications.length) {
      return;
    }

    const application = this.skillApplications[applicationId];
    const skill = this.skills.get(application.skillId);

    if (!skill) return;

    // Update skill proficiency
    const alpha = 0.1; // Learning rate
    const delta = success ? 0.05 : -0.1; // Gain more from failure than success
    skill.proficiency = Math.max(
      0.1,
      Math.min(1, skill.proficiency + delta)
    );

    // Update skill success rate
    skill.successRate =
      skill.successRate * (1 - alpha) + (success ? 1 : 0) * alpha;

    this.persistSkills();
  }

  /**
   * Get transfer learning statistics
   */
  getTransferStats(): Record<string, unknown> {
    const totalSkills = this.skills.size;
    const totalApplications = this.skillApplications.length;

    const successfulApplications = this.skillApplications.filter((a) => a.successRate > 0.5).length;

    const avgProficiency =
      totalSkills > 0
        ? Array.from(this.skills.values()).reduce(
            (sum, s) => sum + s.proficiency,
            0
          ) / totalSkills
        : 0;

    const avgTransferCount =
      totalSkills > 0
        ? Array.from(this.skills.values()).reduce(
            (sum, s) => sum + s.transferCount,
            0
          ) / totalSkills
        : 0;

    return {
      totalSkills,
      totalApplications,
      successfulApplications,
      successRate:
        totalApplications > 0
          ? (successfulApplications / totalApplications) * 100
          : 0,
      avgProficiency,
      avgTransferCount,
      totalProjects: this.projects.size,
      totalDomains: this.domains.size,
    };
  }

  /**
   * Get skills for a specific domain
   */
  getDomainSkills(domain: string): TransferableSkill[] {
    return Array.from(this.skills.values()).filter((s) =>
      s.applicableDomains.includes(domain)
    );
  }

  /**
   * Identify related domains and projects
   */
  getProjectRecommendations(projectId: string): Array<{
    projectId: string;
    name: string;
    similarity: number;
    commonSkills: string[];
  }> {
    const project = this.projects.get(projectId);
    if (!project) return [];

    const recommendations: Array<{
      projectId: string;
      name: string;
      similarity: number;
      commonSkills: string[];
    }> = [];

    this.projects.forEach((other) => {
      if (other.projectId === projectId) return;

      // Calculate similarity
      let similarity = 0;

      // Same domain
      if (other.domain === project.domain) {
        similarity += 0.6;
      } else {
        const domainSim = this.getDomainsimilarity(
          project.domain,
          other.domain
        );
        similarity += domainSim * 0.6;
      }

      // Common skills
      const commonSkillIds = project.skills
        .map((s) => s.id)
        .filter((id) => other.skills.map((s) => s.id).includes(id));

      similarity += (commonSkillIds.length / Math.max(project.skills.length, 1)) * 0.4;

      if (similarity > 0.3) {
        recommendations.push({
          projectId: other.projectId,
          name: other.name,
          similarity,
          commonSkills: commonSkillIds,
        });
      }
    });

    recommendations.sort((a, b) => b.similarity - a.similarity);
    return recommendations.slice(0, 5);
  }

  /**
   * Cross-domain knowledge synthesis
   */
  synthesizeCrossDomainKnowledge(): Record<string, unknown> {
    const synthesis: Record<string, unknown> = {};

    // Find skills that work across multiple domains
    const crossDomainSkills: TransferableSkill[] = [];
    this.skills.forEach((skill) => {
      if (skill.applicableDomains.length > 1) {
        crossDomainSkills.push(skill);
      }
    });

    synthesis['crossDomainSkillCount'] = crossDomainSkills.length;
    synthesis['topCrossDomainSkills'] = crossDomainSkills
      .sort((a, b) => b.proficiency - a.proficiency)
      .slice(0, 5)
      .map((s) => ({
        name: s.name,
        domains: s.applicableDomains,
        proficiency: s.proficiency,
      }));

    // Domain bridges
    const domainBridges: Record<string, number> = {};
    crossDomainSkills.forEach((skill) => {
      for (let i = 0; i < skill.applicableDomains.length - 1; i++) {
        const bridge = `${skill.applicableDomains[i]} <-> ${skill.applicableDomains[i + 1]}`;
        domainBridges[bridge] = (domainBridges[bridge] || 0) + 1;
      }
    });

    synthesis['domainBridges'] = domainBridges;

    return synthesis;
  }

  private initializeDomains(): void {
    const defaultDomains = [
      {
        domain: 'automation',
        relatedDomains: ['productivity', 'scripting'],
      },
      {
        domain: 'analysis',
        relatedDomains: ['research', 'investigation'],
      },
      {
        domain: 'productivity',
        relatedDomains: ['automation', 'organization'],
      },
      {
        domain: 'research',
        relatedDomains: ['analysis', 'investigation'],
      },
    ];

    defaultDomains.forEach(({ domain, relatedDomains }) => {
      const profile: DomainProfile = {
        domain,
        description: `${domain} domain`,
        relatedDomains,
        commonSkills: [],
        successRateBoost: 0.15,
        timestamp: Date.now(),
      };

      this.domains.set(domain, profile);
    });

    // Initialize domain similarity
    defaultDomains.forEach(({ domain, relatedDomains }) => {
      const similarities = new Map<string, number>();

      this.domains.forEach((d) => {
        if (d.domain === domain) {
          similarities.set(d.domain, 1.0); // Self-similarity
        } else if (relatedDomains.includes(d.domain)) {
          similarities.set(d.domain, 0.7); // Related domains
        } else {
          similarities.set(d.domain, 0.3); // Unrelated domains
        }
      });

      this.domainSimilarity.set(domain, similarities);
    });
  }

  private getDomainsimilarity(domain1: string, domain2: string): number {
    const similarities = this.domainSimilarity.get(domain1);
    if (!similarities) return 0.3;
    return similarities.get(domain2) || 0.3;
  }

  private isRelatedDomain(domain1: string, domain2: string): boolean {
    return this.getDomainsimilarity(domain1, domain2) > 0.5;
  }

  private loadTransferData(): void {
    try {
      const skillsPath = path.join(this.dataPath, 'transferable_skills.json');
      if (fs.existsSync(skillsPath)) {
        const data = JSON.parse(fs.readFileSync(skillsPath, 'utf8'));
        Object.entries(data).forEach(([id, skill]: any) => {
          this.skills.set(id, skill);
        });
      }

      const projectsPath = path.join(this.dataPath, 'transfer_projects.json');
      if (fs.existsSync(projectsPath)) {
        const data = JSON.parse(fs.readFileSync(projectsPath, 'utf8'));
        Object.entries(data).forEach(([id, project]: any) => {
          this.projects.set(id, project);
        });
      }
    } catch (err) {
      console.warn('[TransferLearner] Could not load transfer data', err);
    }
  }

  private persistProjectRegistry(): void {
    const registryPath = path.join(this.dataPath, 'transfer_projects.json');
    const registry: Record<string, ProjectContext> = {};

    this.projects.forEach((project, id) => {
      registry[id] = project;
    });

    try {
      fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
    } catch (err) {
      console.error('[TransferLearner] Failed to persist projects', err);
    }
  }

  private persistSkills(): void {
    const skillsPath = path.join(this.dataPath, 'transferable_skills.json');
    const skillsData: Record<string, TransferableSkill> = {};

    this.skills.forEach((skill, id) => {
      skillsData[id] = skill;
    });

    try {
      fs.writeFileSync(skillsPath, JSON.stringify(skillsData, null, 2));
    } catch (err) {
      console.error('[TransferLearner] Failed to persist skills', err);
    }
  }
}

// Singleton instance
let transferLearnerInstance: TransferLearner | null = null;

export function getTransferLearner(dataPath?: string): TransferLearner {
  if (!transferLearnerInstance) {
    transferLearnerInstance = new TransferLearner(dataPath);
  }
  return transferLearnerInstance;
}
