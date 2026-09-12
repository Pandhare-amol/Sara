import type { FeedbackEvent, LearningRecord } from "./advanced-types";

export class ContinuousLearningService {
  private readonly feedback: FeedbackEvent[] = [];
  private readonly records: LearningRecord[] = [];
  private lastTrainingAt = 0;
  constructor(private readonly trainingIntervalMs = 86_400_000) {}
  recordFeedback(event: FeedbackEvent): void { this.feedback.push({ ...event }); }
  addRecord(record: Omit<LearningRecord, "id" | "createdAt">): LearningRecord { const saved = { ...record, id: crypto.randomUUID(), createdAt: Date.now() }; this.records.push(saved); return saved; }
  shouldTrain(now = Date.now()): boolean { return this.records.length > 0 && now - this.lastTrainingAt >= this.trainingIntervalMs; }
  async train(train: (records: LearningRecord[], feedback: FeedbackEvent[]) => Promise<void>): Promise<void> { if (!this.shouldTrain()) return; await train([...this.records], [...this.feedback]); this.lastTrainingAt = Date.now(); }
  snapshot(): { feedback: FeedbackEvent[]; records: LearningRecord[]; lastTrainingAt: number } { return { feedback: [...this.feedback], records: [...this.records], lastTrainingAt: this.lastTrainingAt }; }
}
