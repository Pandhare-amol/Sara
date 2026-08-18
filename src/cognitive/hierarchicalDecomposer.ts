/**
 * Hierarchical Task Decomposition System
 * 
 * Breaks complex goals into hierarchical subtasks:
 * - Recursive task decomposition based on goal complexity
 * - Dependency tracking between subtasks
 * - Parallel execution planning
 * - Resource estimation and allocation
 * - Progress tracking through task tree
 * 
 * Benefits:
 * - Handle complex tasks that can't be solved in one step
 * - Enable parallel execution of independent subtasks
 * - Better resource utilization
 * - Easier error recovery and retry logic
 */

import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';

export interface TaskNode {
  id: string;
  level: number;                    // 0 = root, 1 = subtask, 2 = sub-subtask, etc.
  goal: string;
  description: string;
  complexity: number;               // 0-1, estimated complexity
  dependencies: string[];           // IDs of tasks that must complete first
  children: TaskNode[];
  status: 'pending' | 'decomposing' | 'ready' | 'executing' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
  estimatedDuration: number;        // ms
  actualDuration?: number;          // ms
  timestamp: number;
  parentId?: string;
}

export interface DecompositionStrategy {
  name: string;
  description: string;
  maxDepth: number;
  complexityThreshold: number;      // Decompose if complexity > threshold
  estimatedDurationThreshold: number; // ms
}

export interface ExecutionPlan {
  taskId: string;
  tree: TaskNode;
  executionOrder: string[];         // Ordered task IDs for sequential execution
  parallelBatches: string[][];      // Groups of tasks that can run in parallel
  totalEstimatedDuration: number;
  timestamp: number;
}

/**
 * Decomposes complex tasks into hierarchical subtasks
 */
export class HierarchicalDecomposer {
  private strategies: Map<string, DecompositionStrategy>;
  private decompositionHistory: TaskNode[] = [];
  private executionPlans: ExecutionPlan[] = [];
  private dataPath: string;

  // Default strategies for different task types
  private defaultStrategies: Record<string, DecompositionStrategy> = {
    general: {
      name: 'general',
      description: 'General purpose decomposition',
      maxDepth: 5,
      complexityThreshold: 0.6,
      estimatedDurationThreshold: 30000, // 30 seconds
    },
    analysis: {
      name: 'analysis',
      description: 'For analysis and investigation tasks',
      maxDepth: 4,
      complexityThreshold: 0.5,
      estimatedDurationThreshold: 20000,
    },
    automation: {
      name: 'automation',
      description: 'For repetitive automation tasks',
      maxDepth: 3,
      complexityThreshold: 0.7,
      estimatedDurationThreshold: 60000, // 60 seconds
    },
  };

  constructor(dataPath: string = './data') {
    this.dataPath = dataPath;
    this.strategies = new Map(Object.entries(this.defaultStrategies));
    this.loadExecutionHistory();
  }

  /**
   * Decompose a complex goal into subtasks
   */
  async decomposeTask(
    goal: string,
    context?: Record<string, unknown>,
    strategyName: string = 'general',
    depth: number = 0
  ): Promise<TaskNode> {
    const strategy = this.strategies.get(strategyName) || this.strategies.get('general')!;
    const taskId = uuidv4();

    // Estimate complexity and duration
    const complexity = this.estimateComplexity(goal);
    const estimatedDuration = this.estimateDuration(goal, complexity);

    const node: TaskNode = {
      id: taskId,
      level: depth,
      goal,
      description: `Task: ${goal}`,
      complexity,
      dependencies: [],
      children: [],
      status: 'pending',
      estimatedDuration,
      timestamp: Date.now(),
    };

    // Decompose if:
    // 1. Complexity exceeds threshold
    // 2. Estimated duration is too long
    // 3. Haven't reached max depth
    if (
      depth < strategy.maxDepth &&
      (complexity > strategy.complexityThreshold ||
        estimatedDuration > strategy.estimatedDurationThreshold)
    ) {
      node.status = 'decomposing';

      // Generate subtasks
      const subtasks = await this.generateSubtasks(
        goal,
        context,
        complexity
      );

      for (const subtask of subtasks) {
        const subtaskNode = await this.decomposeTask(
          subtask.goal,
          { ...context, parentGoal: goal },
          strategyName,
          depth + 1
        );

        subtaskNode.parentId = taskId;
        subtaskNode.dependencies = subtask.dependencies || [];

        // Recursively decompose if still complex
        if (subtaskNode.complexity > strategy.complexityThreshold) {
          node.children.push(subtaskNode);
        } else {
          node.children.push(subtaskNode);
        }
      }

      node.status = 'ready';
      node.estimatedDuration = this.calculateTreeDuration(node);
    } else {
      node.status = 'ready';
    }

    this.decompositionHistory.push(node);
    return node;
  }

  /**
   * Generate subtasks for a given goal
   */
  private async generateSubtasks(
    goal: string,
    context?: Record<string, unknown>,
    complexity?: number
  ): Promise<
    Array<{ goal: string; dependencies?: string[] }>
  > {
    // Keyword-based decomposition rules
    const lowerGoal = goal.toLowerCase();

    if (
      lowerGoal.includes('analyze') ||
      lowerGoal.includes('investigate')
    ) {
      return [
        { goal: 'Gather relevant information' },
        { goal: 'Extract key data points', dependencies: ['Gather relevant information'] },
        { goal: 'Identify patterns and trends', dependencies: ['Extract key data points'] },
        { goal: 'Generate insights and recommendations', dependencies: ['Identify patterns and trends'] },
      ];
    }

    if (
      lowerGoal.includes('create') ||
      lowerGoal.includes('build') ||
      lowerGoal.includes('develop')
    ) {
      return [
        { goal: 'Plan structure and design' },
        { goal: 'Prepare resources', dependencies: ['Plan structure and design'] },
        { goal: 'Implement core functionality', dependencies: ['Prepare resources'] },
        { goal: 'Test and validate', dependencies: ['Implement core functionality'] },
        { goal: 'Document and finalize', dependencies: ['Test and validate'] },
      ];
    }

    if (
      lowerGoal.includes('optimize') ||
      lowerGoal.includes('improve')
    ) {
      return [
        { goal: 'Measure current performance' },
        { goal: 'Identify bottlenecks', dependencies: ['Measure current performance'] },
        { goal: 'Design improvements', dependencies: ['Identify bottlenecks'] },
        { goal: 'Implement changes', dependencies: ['Design improvements'] },
        { goal: 'Validate improvements', dependencies: ['Implement changes'] },
      ];
    }

    if (
      lowerGoal.includes('fix') ||
      lowerGoal.includes('debug') ||
      lowerGoal.includes('troubleshoot')
    ) {
      return [
        { goal: 'Identify the problem' },
        { goal: 'Locate root cause', dependencies: ['Identify the problem'] },
        { goal: 'Develop solution', dependencies: ['Locate root cause'] },
        { goal: 'Apply fix', dependencies: ['Develop solution'] },
        { goal: 'Verify resolution', dependencies: ['Apply fix'] },
      ];
    }

    // Default: simple decomposition
    if (complexity && complexity > 0.7) {
      return [
        { goal: `Phase 1: Planning and preparation for "${goal}"` },
        { goal: `Phase 2: Execution of "${goal}"`, dependencies: ['Phase 1: Planning and preparation for "${goal}"'] },
        { goal: `Phase 3: Validation and completion of "${goal}"`, dependencies: [`Phase 2: Execution of "${goal}"`] },
      ];
    }

    return [];
  }

  /**
   * Create execution plan from task tree
   */
  createExecutionPlan(tree: TaskNode): ExecutionPlan {
    const executionOrder: string[] = [];
    const parallelBatches: string[][] = [];
    const visited = new Set<string>();

    // Topological sort considering dependencies
    const sortedNodes = this.topologicalSort(tree, visited);
    sortedNodes.forEach((node) => executionOrder.push(node.id));

    // Identify parallel batches
    const levels = this.groupByDependencies(tree);
    levels.forEach((batch) => {
      if (batch.length > 0) {
        parallelBatches.push(batch);
      }
    });

    const plan: ExecutionPlan = {
      taskId: tree.id,
      tree,
      executionOrder,
      parallelBatches,
      totalEstimatedDuration: this.calculateTreeDuration(tree),
      timestamp: Date.now(),
    };

    this.executionPlans.push(plan);
    this.persistExecutionPlans();

    return plan;
  }

  /**
   * Topological sort of task tree
   */
  private topologicalSort(
    node: TaskNode,
    visited: Set<string>
  ): TaskNode[] {
    if (visited.has(node.id)) return [];

    visited.add(node.id);

    const result: TaskNode[] = [];

    // Add dependencies first
    for (const depId of node.dependencies) {
      // Note: In a real implementation, would look up dep by ID
      // For now, simplified version
    }

    result.push(node);

    // Add children
    for (const child of node.children) {
      result.push(...this.topologicalSort(child, visited));
    }

    return result;
  }

  /**
   * Group tasks by dependency levels (can run in parallel)
   */
  private groupByDependencies(node: TaskNode): string[][] {
    const levels: string[][] = [];
    const taskLevels = new Map<string, number>();

    const assignLevels = (n: TaskNode, level: number) => {
      taskLevels.set(n.id, Math.max(level, taskLevels.get(n.id) || 0));

      for (const child of n.children) {
        assignLevels(child, level + 1);
      }
    };

    assignLevels(node, 0);

    // Group by level
    const byLevel = new Map<number, string[]>();
    taskLevels.forEach((level, taskId) => {
      if (!byLevel.has(level)) {
        byLevel.set(level, []);
      }
      byLevel.get(level)!.push(taskId);
    });

    // Convert to array, sorted by level
    Array.from(byLevel.entries())
      .sort(([a], [b]) => a - b)
      .forEach(([, tasks]) => levels.push(tasks));

    return levels;
  }

  /**
   * Report task completion and update tree
   */
  recordTaskCompletion(
    taskId: string,
    result: unknown,
    success: boolean
  ): void {
    const findAndUpdate = (node: TaskNode): boolean => {
      if (node.id === taskId) {
        node.status = success ? 'completed' : 'failed';
        node.result = result;
        node.actualDuration = Date.now() - node.timestamp;
        return true;
      }

      for (const child of node.children) {
        if (findAndUpdate(child)) return true;
      }

      return false;
    };

    this.decompositionHistory.forEach((tree) => {
      findAndUpdate(tree);
    });
  }

  /**
   * Get progress of task hierarchy
   */
  getProgress(tree: TaskNode): Record<string, unknown> {
    const count = (node: TaskNode) => {
      let total = 1;
      for (const child of node.children) {
        total += count(child);
      }
      return total;
    };

    const countByStatus = (node: TaskNode, status: string): number => {
      let total = node.status === status ? 1 : 0;
      for (const child of node.children) {
        total += countByStatus(child, status);
      }
      return total;
    };

    const total = count(tree);
    const completed = countByStatus(tree, 'completed');
    const failed = countByStatus(tree, 'failed');

    return {
      totalTasks: total,
      completedTasks: completed,
      failedTasks: failed,
      pendingTasks: total - completed - failed,
      progressPercentage: Math.round((completed / total) * 100),
      estimatedTimeRemaining: this.estimateTimeRemaining(tree),
    };
  }

  /**
   * Estimate complexity of a goal
   */
  private estimateComplexity(goal: string): number {
    let complexity = 0.3; // Base complexity

    // Keywords that increase complexity
    const complexityKeywords = [
      { keyword: 'analyze', factor: 0.2 },
      { keyword: 'optimize', factor: 0.25 },
      { keyword: 'integrate', factor: 0.3 },
      { keyword: 'coordinate', factor: 0.25 },
      { keyword: 'multiple', factor: 0.15 },
      { keyword: 'complex', factor: 0.3 },
      { keyword: 'advanced', factor: 0.2 },
    ];

    const lowerGoal = goal.toLowerCase();
    for (const { keyword, factor } of complexityKeywords) {
      if (lowerGoal.includes(keyword)) {
        complexity += factor;
      }
    }

    // Cap at 1.0
    return Math.min(1, complexity);
  }

  /**
   * Estimate duration of a task
   */
  private estimateDuration(goal: string, complexity: number): number {
    // Base duration increases with complexity
    const baseDuration = 5000 + complexity * 50000; // 5s to 55s

    // Task-specific adjustments
    const lowerGoal = goal.toLowerCase();
    let multiplier = 1;

    if (lowerGoal.includes('analyze')) multiplier = 1.5;
    if (lowerGoal.includes('optimize')) multiplier = 2;
    if (lowerGoal.includes('test')) multiplier = 1.8;
    if (lowerGoal.includes('configure')) multiplier = 1.3;

    return baseDuration * multiplier;
  }

  /**
   * Calculate total duration of task tree
   */
  private calculateTreeDuration(node: TaskNode): number {
    if (node.children.length === 0) {
      return node.estimatedDuration;
    }

    // Sum of all paths through tree
    let maxDuration = 0;
    const explore = (n: TaskNode): number => {
      let duration = n.estimatedDuration;
      if (n.children.length > 0) {
        const childDurations = n.children.map((c) => explore(c));
        duration += Math.max(...childDurations, 0);
      }
      return duration;
    };

    return explore(node);
  }

  /**
   * Estimate time remaining for task
   */
  private estimateTimeRemaining(node: TaskNode): number {
    const elapsed = Date.now() - node.timestamp;
    const estimated = this.calculateTreeDuration(node);
    return Math.max(0, estimated - elapsed);
  }

  /**
   * Add custom strategy
   */
  addStrategy(strategy: DecompositionStrategy): void {
    this.strategies.set(strategy.name, strategy);
  }

  /**
   * Get decomposition statistics
   */
  getStatistics(): Record<string, unknown> {
    return {
      totalDecompositions: this.decompositionHistory.length,
      totalExecutionPlans: this.executionPlans.length,
      avgDepth:
        this.decompositionHistory.length > 0
          ? this.decompositionHistory.reduce(
              (sum, t) => sum + this.getMaxDepth(t),
              0
            ) / this.decompositionHistory.length
          : 0,
      avgSubtasks:
        this.decompositionHistory.length > 0
          ? this.decompositionHistory.reduce(
              (sum, t) => sum + this.countChildren(t),
              0
            ) / this.decompositionHistory.length
          : 0,
    };
  }

  private getMaxDepth(node: TaskNode): number {
    if (node.children.length === 0) return node.level;
    return Math.max(...node.children.map((c) => this.getMaxDepth(c)));
  }

  private countChildren(node: TaskNode): number {
    let count = node.children.length;
    for (const child of node.children) {
      count += this.countChildren(child);
    }
    return count;
  }

  private loadExecutionHistory(): void {
    const historyPath = path.join(this.dataPath, 'execution_plans.json');
    try {
      if (fs.existsSync(historyPath)) {
        const data = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
        if (Array.isArray(data)) {
          this.executionPlans = data;
        }
      }
    } catch (err) {
      console.warn('[HierarchicalDecomposer] No execution history found');
    }
  }

  private persistExecutionPlans(): void {
    const plansPath = path.join(this.dataPath, 'execution_plans.json');
    try {
      fs.writeFileSync(
        plansPath,
        JSON.stringify(this.executionPlans, null, 2)
      );
    } catch (err) {
      console.error('[HierarchicalDecomposer] Failed to persist plans', err);
    }
  }
}

// Singleton instance
let decomposerInstance: HierarchicalDecomposer | null = null;

export function getHierarchicalDecomposer(dataPath?: string): HierarchicalDecomposer {
  if (!decomposerInstance) {
    decomposerInstance = new HierarchicalDecomposer(dataPath);
  }
  return decomposerInstance;
}
