import type { CollaborationMessage, ConsensusResult } from "./advanced-types";

export class CollaborationHub {
  private readonly messages: CollaborationMessage[] = [];
  publish(message: CollaborationMessage): void { this.messages.push(message); }
  history(taskId: string): CollaborationMessage[] { return this.messages.filter((message) => message.taskId === taskId).map((message) => ({ ...message })); }
  consensus(taskId: string): ConsensusResult {
    const votes = this.history(taskId).map((message) => ({ agentId: message.from, decision: message.content, confidence: message.confidence }));
    const groups = new Map<string, typeof votes>();
    for (const vote of votes) groups.set(vote.decision, [...(groups.get(vote.decision) ?? []), vote]);
    const ranked = [...groups.entries()].sort((a, b) => b[1].reduce((sum, vote) => sum + vote.confidence, 0) - a[1].reduce((sum, vote) => sum + vote.confidence, 0));
    const winner = ranked[0];
    return { decision: winner?.[0] ?? "No decision", confidence: winner ? winner[1].reduce((sum, vote) => sum + vote.confidence, 0) / winner[1].length : 0, votes, conflicts: ranked.slice(1).map(([decision]) => decision) };
  }
}
