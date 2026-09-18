export const DesktopControlConfig = {
  confidenceThreshold: 0.85,
  retryCount: 3,
  diagnosticMode: false,
  globalShortcuts: {
    emergencyStop: 'Ctrl+Shift+Esc',
  },
  stressTest: {
    tempDir: 'C:\\Temp\\SARA_TEST', // temporary folder for test artifacts
    timeoutMs: 90000, // max wait per phase
    retryAttempts: 2,
    ocrConfidenceThreshold: 0.8,
    logFile: 'stress_test_log.json',
  },
  dangerousActions: [],
};

