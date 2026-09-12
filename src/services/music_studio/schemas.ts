export interface MusicProject {
  project_id: string;
  user_id: string;
  title: string;
  concept: string;
  genre: string;
  mood: string;
  language: string;
  target_audience: string;
  lyrics: string;
  composition_metadata: string;
  bpm: number;
  key: string;
  time_signature: string;
  vocal_configuration: string;
  instrument_configuration: string;
  production_status: string;
  quality_report: string;
  publishing_status: string;
  youtube_metadata: string;
  instagram_metadata: string;
  analytics_summary: string;
  created_at: string;
  updated_at: string;
}

export interface MusicAsset {
  id: string;
  project_id: string;
  asset_type: string;
  file_path: string;
  metadata: string;
  created_at: string;
}

export type MusicProjectStatus = 
  | "IDEA"
  | "CONCEPT"
  | "LYRICS"
  | "COMPOSITION"
  | "VOCAL"
  | "ARRANGEMENT"
  | "MIXING"
  | "MASTERING"
  | "QUALITY_CHECK"
  | "USER_APPROVAL"
  | "PUBLISH"
  | "PROMOTION"
  | "ANALYTICS";
