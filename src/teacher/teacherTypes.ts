export type TeacherMode =
  | "NORMAL"
  | "TEACHER"
  | "EXAM_PREPARATION"
  | "REVISION"
  | "QUIZ"
  | "MOCK_TEST"
  | "DOUBT_SOLVING";

export type StudentLevel = "BEGINNER" | "INTERMEDIATE" | "ADVANCED";
export type StudySessionStatus = "PLANNED" | "ACTIVE" | "PAUSED" | "COMPLETED" | "ABANDONED";

export interface SyllabusTopic {
  id: string;
  title: string;
  difficulty: "beginner" | "intermediate" | "advanced";
  status: "not_started" | "in_progress" | "mastered";
  objectives: string[];
}

export interface SyllabusUnit {
  unit: number;
  title: string;
  topics: SyllabusTopic[];
}

export interface SyllabusDocument {
  syllabusId: string;
  studentId: string;
  subject: string;
  exam?: string;
  title: string;
  sourceType: "text" | "pdf" | "docx" | "image";
  sourceName?: string;
  extractedText: string;
  units: SyllabusUnit[];
  extraction: { method: "plain_text" | "pypdf" | "docx" | "ocr" | "provided_text"; confidence: number; warnings: string[] };
  createdAt: string;
  updatedAt: string;
}

export interface StudentProfile {
  studentId: string;
  displayName: string;
  subjects: string[];
  strengths: string[];
  weaknesses: string[];
  mistakePatterns: Array<{ type: string; count: number; lastSeenAt: string }>;
  evidence: Array<{ kind: string; subject?: string; topic?: string; score?: number; note?: string; recordedAt: string }>;
  examReadiness: Record<string, number>;
  createdAt: string;
  updatedAt: string;
}

export interface StudySession {
  sessionId: string;
  studentId: string;
  syllabusId?: string;
  mode: Exclude<TeacherMode, "NORMAL">;
  subject: string;
  startedAt: string;
  endedAt?: string;
  status: StudySessionStatus;
  currentUnit?: number;
  currentTopicId?: string;
  taughtTopicIds: string[];
  taskIds: string[];
  summary: string[];
  updatedAt: string;
}

export interface TeacherState {
  mode: TeacherMode;
  activeStudentId: string;
  syllabi: SyllabusDocument[];
  students: StudentProfile[];
  sessions: StudySession[];
}
