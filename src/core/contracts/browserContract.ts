export type BrowserStatus = "STOPPED" | "STARTING" | "READY" | "BUSY" | "ERROR" | "RECOVERING";
export type BrowserTabLoadingState = "IDLE" | "LOADING" | "LOADED" | "FAILED" | "STOPPED";
export type BrowserNavigationState = "NONE" | "NAVIGATING" | "COMMITTED" | "COMPLETED" | "FAILED";
export type BrowserRendererState = "UNKNOWN" | "DIRECT" | "EMBEDDED" | "ERROR";
export type BrowserProcessState = "UNKNOWN" | "RUNNING" | "CRASHED" | "CLOSED";

export interface BrowserTabState {
  tabId: string;
  sessionId: string;
  url: string;
  title: string;
  favicon?: string;
  loadingState: BrowserTabLoadingState;
  navigationState: BrowserNavigationState;
  rendererState: BrowserRendererState;
  processState: BrowserProcessState;
  active: boolean;
  createdAt: string;
  lastActiveAt: string;
  lastError?: {
    code: string;
    message: string;
    retryable: boolean;
    timestamp: string;
  };
  downloadState?: {
    status: "IDLE" | "STARTED" | "COMPLETED" | "FAILED";
    filename?: string;
    path?: string;
  };
  mediaState?: {
    status: "UNKNOWN" | "OPENING" | "PLAYER_READY" | "BUFFERING" | "PLAYING" | "PAUSED" | "ENDED" | "FAILED";
    currentTime?: number;
    duration?: number;
    paused?: boolean;
    ended?: boolean;
  };
}

export interface BrowserSessionState {
  sessionId: string;
  profileName: string;
  persistencePartition?: string;
  status: BrowserStatus;
  activeTabId?: string;
  tabs: BrowserTabState[];
  createdAt: string;
  updatedAt: string;
  lastError?: {
    code: string;
    message: string;
    retryable: boolean;
    timestamp: string;
  };
}

export type BrowserEventType =
  | "BROWSER_STARTED"
  | "BROWSER_READY"
  | "BROWSER_ERROR"
  | "BROWSER_RECOVERING"
  | "BROWSER_STOPPED"
  | "BROWSER_TAB_CREATED"
  | "BROWSER_TAB_CLOSED"
  | "BROWSER_TAB_ACTIVATED"
  | "BROWSER_NAVIGATED"
  | "BROWSER_LOADING"
  | "BROWSER_LOADED"
  | "BROWSER_DOWNLOAD_STARTED"
  | "BROWSER_DOWNLOAD_COMPLETED"
  | "BROWSER_DOWNLOAD_FAILED"
  | "BROWSER_PAGE_CRASHED"
  | "BROWSER_MEDIA_STATE_CHANGED";

export interface BrowserEvent {
  type: BrowserEventType;
  sessionId: string;
  tabId?: string;
  taskId?: string;
  operationId?: string;
  timestamp: string;
  data?: Record<string, unknown>;
}
