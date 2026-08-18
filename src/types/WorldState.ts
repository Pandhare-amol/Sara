/**
 * WorldState - Centralized representation of the observable desktop state
 * All autonomous decisions depend on current WorldState accuracy
 */

export interface Observation {
  id: string;
  type: ObservationType;
  value: any;
  confidence: number; // 0.0 to 1.0
  source: ObservationSource;
  timestamp: number;
  duration?: number; // milliseconds for operations
  metadata?: Record<string, any>;
  error?: string;
}

export type ObservationType =
  | 'window_detected'
  | 'application_active'
  | 'cursor_position'
  | 'screen_capture'
  | 'ocr_text'
  | 'ui_element_detected'
  | 'button_detected'
  | 'menu_detected'
  | 'dialog_detected'
  | 'notification_detected'
  | 'loading_state'
  | 'visual_change'
  | 'file_exists'
  | 'file_modified'
  | 'process_running'
  | 'network_state'
  | 'clipboard_content'
  | 'window_bounds'
  | 'text_field_focused'
  | 'error_detected';

export type ObservationSource =
  | 'window_api'
  | 'screenshot'
  | 'ocr'
  | 'accessibility'
  | 'dom'
  | 'filesystem'
  | 'process_monitor'
  | 'network_monitor'
  | 'vision'
  | 'user_input'
  | 'previous_action_result';

export interface Window {
  hwnd?: number;
  pid?: number;
  title: string;
  className: string;
  isVisible: boolean;
  isActive: boolean;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  processName?: string;
  appName?: string;
  confidence: number;
}

export interface UIElement {
  id: string;
  type: 'button' | 'textfield' | 'menu' | 'dialog' | 'label' | 'checkbox' | 'dropdown' | 'text' | 'other';
  text?: string;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  isInteractable: boolean;
  isVisible: boolean;
  confidence: number;
  source: 'accessibility' | 'dom' | 'vision';
}

export interface Screen {
  width: number;
  height: number;
  dpi: number;
  monitorCount: number;
  primaryMonitor: {
    width: number;
    height: number;
    bounds: {
      x: number;
      y: number;
    };
  };
  captures: ScreenCapture[];
}

export interface ScreenCapture {
  id: string;
  timestamp: number;
  base64?: string;
  path?: string;
  width: number;
  height: number;
  confidence: number;
}

export interface CursorState {
  x: number;
  y: number;
  timestamp: number;
  confidence: number;
}

export interface FileState {
  path: string;
  exists: boolean;
  size?: number;
  modified?: number;
  created?: number;
  isDirectory: boolean;
  confidence: number;
}

export interface ApplicationState {
  name: string;
  path?: string;
  processId?: number;
  isRunning: boolean;
  isActive: boolean;
  window?: Window;
  confidence: number;
}

export interface SystemState {
  processes: Array<{
    name: string;
    pid: number;
    memory?: number;
  }>;
  networkConnected: boolean;
  clipboard?: {
    text?: string;
    hasImage?: boolean;
    timestamp: number;
  };
  volumeLevel?: number;
  screenLocked?: boolean;
  timestamp: number;
}

export interface WorldState {
  id: string;
  timestamp: number;
  screen: Screen;
  cursor: CursorState;
  activeWindow?: Window;
  activeApplication?: ApplicationState;
  visibleWindows: Window[];
  visibleApplications: ApplicationState[];
  uiElements: UIElement[];
  fileStates: Map<string, FileState>;
  systemState: SystemState;
  observations: Observation[];
  lastObservationTime: number;
  lastChangeTime: number;
  confidence: number; // overall confidence in this world state
  
  // Context for current task
  currentTaskId?: string;
  currentSubtask?: string;
  lastAction?: {
    type: string;
    timestamp: number;
    expectedEffect?: string;
  };
  
  // Change detection
  hasChanged: boolean;
  changesSince?: {
    timestamp: number;
    changes: string[];
  };
}

export interface ObservationResult {
  success: boolean;
  worldState?: WorldState;
  error?: string;
  duration: number;
  confidence: number;
}

export interface PerceptionCapabilities {
  screenshot: boolean;
  ocr: boolean;
  accessibility: boolean;
  dom: boolean;
  windowApi: boolean;
  vision: boolean;
  processMonitoring: boolean;
  networkMonitoring: boolean;
}

export function createEmptyWorldState(): WorldState {
  return {
    id: `world-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    timestamp: Date.now(),
    screen: {
      width: 0,
      height: 0,
      dpi: 96,
      monitorCount: 1,
      primaryMonitor: {
        width: 0,
        height: 0,
        bounds: { x: 0, y: 0 },
      },
      captures: [],
    },
    cursor: {
      x: 0,
      y: 0,
      timestamp: Date.now(),
      confidence: 0,
    },
    visibleWindows: [],
    visibleApplications: [],
    uiElements: [],
    fileStates: new Map(),
    systemState: {
      processes: [],
      networkConnected: true,
      timestamp: Date.now(),
    },
    observations: [],
    lastObservationTime: Date.now(),
    lastChangeTime: Date.now(),
    confidence: 0,
    hasChanged: false,
  };
}

export function createObservation(
  type: ObservationType,
  value: any,
  source: ObservationSource,
  confidence: number = 1.0,
  metadata?: Record<string, any>
): Observation {
  return {
    id: `obs-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    type,
    value,
    confidence,
    source,
    timestamp: Date.now(),
    metadata,
  };
}
