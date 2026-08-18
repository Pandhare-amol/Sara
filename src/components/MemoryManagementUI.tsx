/**
 * Memory Management UI Components
 * React components for viewing, managing, and exporting memories
 */

import React, { useState, useEffect } from 'react';
import { MemoryStore } from '../types/Memory';
import { MemoryPersistenceService } from '../services/MemoryPersistenceService';
import { AdvancedLearningService } from '../services/AdvancedLearningService';
import { LearningWorkflowCoordinator } from '../services/LearningWorkflowCoordinator';

export interface MemoryBrowserProps {
  memoryStore: MemoryStore;
  persistenceService: MemoryPersistenceService;
  learningService: AdvancedLearningService;
}

/**
 * MemoryStatsDashboard - Display memory statistics and health
 */
export const MemoryStatsDashboard: React.FC<{
  memoryStore: MemoryStore;
  persistenceService: MemoryPersistenceService;
}> = ({ memoryStore, persistenceService }) => {
  const [stats, setStats] = useState(
    persistenceService.getMemoryStats(memoryStore)
  );

  useEffect(() => {
    const interval = setInterval(() => {
      setStats(persistenceService.getMemoryStats(memoryStore));
    }, 5000); // Update every 5 seconds

    return () => clearInterval(interval);
  }, [memoryStore, persistenceService]);

  return (
    <div style={styles.statsContainer}>
      <h2 style={styles.title}>Memory Statistics</h2>

      <div style={styles.statsGrid}>
        <div style={styles.statCard}>
          <div style={styles.statLabel}>Total Memories</div>
          <div style={styles.statValue}>{stats.totalMemories}</div>
        </div>

        <div style={styles.statCard}>
          <div style={styles.statLabel}>Average Confidence</div>
          <div style={styles.statValue}>{(stats.averageConfidence * 100).toFixed(1)}%</div>
        </div>

        <div style={styles.statCard}>
          <div style={styles.statLabel}>Episodic</div>
          <div style={styles.statValue}>{stats.byType.episodic}</div>
        </div>

        <div style={styles.statCard}>
          <div style={styles.statLabel}>Semantic</div>
          <div style={styles.statValue}>{stats.byType.semantic}</div>
        </div>

        <div style={styles.statCard}>
          <div style={styles.statLabel}>Procedural</div>
          <div style={styles.statValue}>{stats.byType.procedural}</div>
        </div>

        <div style={styles.statCard}>
          <div style={styles.statLabel}>Achievement</div>
          <div style={styles.statValue}>{stats.byType.achievement}</div>
        </div>

        <div style={styles.statCard}>
          <div style={styles.statLabel}>Failure</div>
          <div style={styles.statValue}>{stats.byType.failure}</div>
        </div>

        <div style={styles.statCard}>
          <div style={styles.statLabel}>Preference</div>
          <div style={styles.statValue}>{stats.byType.preference}</div>
        </div>
      </div>

      <div style={styles.lastSaveInfo}>
        Last Save: {stats.lastSaveTime > 0
          ? new Date(stats.lastSaveTime).toLocaleString()
          : 'Never'}
      </div>
    </div>
  );
};

/**
 * MemoryBrowser - Browse and filter memories by type
 */
export const MemoryBrowser: React.FC<MemoryBrowserProps> = ({
  memoryStore,
  persistenceService,
  learningService,
}) => {
  const [selectedType, setSelectedType] = useState<string>('episodic');
  const [filter, setFilter] = useState<string>('');
  const [memories, setMemories] = useState<any[]>([]);

  useEffect(() => {
    const getMemoriesByType = () => {
      const store = memoryStore as Record<string, Map<string, any>>;
      const memoryMap = store[selectedType];

      if (!memoryMap) {
        setMemories([]);
        return;
      }

      let items = Array.from(memoryMap.values());

      // Apply filter
      if (filter) {
        items = items.filter((item) => {
          const str = JSON.stringify(item).toLowerCase();
          return str.includes(filter.toLowerCase());
        });
      }

      setMemories(items);
    };

    getMemoriesByType();
  }, [selectedType, filter, memoryStore]);

  const handleExport = async (format: 'json' | 'csv' | 'markdown') => {
    // This would be called with the workflow coordinator in a real app
    console.log(`Exporting memories as ${format}`);
  };

  return (
    <div style={styles.browserContainer}>
      <h2 style={styles.title}>Memory Browser</h2>

      <div style={styles.controls}>
        <select
          value={selectedType}
          onChange={(e) => setSelectedType(e.target.value)}
          style={styles.select}
        >
          <option value="episodic">Episodic (What Happened)</option>
          <option value="semantic">Semantic (Facts)</option>
          <option value="procedural">Procedural (Skills)</option>
          <option value="preference">Preference (Choices)</option>
          <option value="failure">Failure (Problems)</option>
          <option value="achievement">Achievement (Success)</option>
          <option value="autobiographical">Autobiographical (History)</option>
        </select>

        <input
          type="text"
          placeholder="Filter memories..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={styles.filterInput}
        />

        <button onClick={() => handleExport('json')} style={styles.button}>
          Export JSON
        </button>
        <button onClick={() => handleExport('markdown')} style={styles.button}>
          Export Markdown
        </button>
      </div>

      <div style={styles.memoryList}>
        {memories.length === 0 ? (
          <div style={styles.emptyState}>No memories of this type</div>
        ) : (
          memories.map((memory, idx) => (
            <div key={idx} style={styles.memoryItem}>
              <pre style={styles.memoryContent}>{JSON.stringify(memory, null, 2)}</pre>
            </div>
          ))
        )}
      </div>

      <div style={styles.footer}>Found {memories.length} memories</div>
    </div>
  );
};

/**
 * LearningReportPanel - Display learning achievements and insights
 */
export const LearningReportPanel: React.FC<{
  learningService: AdvancedLearningService;
  onRefresh?: () => void;
}> = ({ learningService, onRefresh }) => {
  const [report, setReport] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadReport = async () => {
      try {
        const data = await learningService.getLearningReport();
        setReport(data);
        setLoading(false);
      } catch (error) {
        console.error('Error loading learning report:', error);
        setLoading(false);
      }
    };

    loadReport();
  }, [learningService, onRefresh]);

  if (loading) {
    return <div style={styles.loadingState}>Loading learning report...</div>;
  }

  if (!report) {
    return <div style={styles.errorState}>Failed to load learning report</div>;
  }

  return (
    <div style={styles.reportContainer}>
      <h2 style={styles.title}>Learning Report</h2>

      <div style={styles.reportGrid}>
        <div style={styles.reportCard}>
          <div style={styles.reportLabel}>Skills Extracted</div>
          <div style={styles.reportValue}>{report.skillsExtracted}</div>
          <div style={styles.reportDescription}>New skills created from successful tasks</div>
        </div>

        <div style={styles.reportCard}>
          <div style={styles.reportLabel}>Failure Patterns</div>
          <div style={styles.reportValue}>{report.failurePatterns}</div>
          <div style={styles.reportDescription}>Recognized failure types</div>
        </div>

        <div style={styles.reportCard}>
          <div style={styles.reportLabel}>Strategies Optimized</div>
          <div style={styles.reportValue}>{report.strategiesOptimized}</div>
          <div style={styles.reportDescription}>Recovery strategies with performance tracking</div>
        </div>

        <div style={styles.reportCard}>
          <div style={styles.reportLabel}>Learning Events</div>
          <div style={styles.reportValue}>{report.totalLearningEvents}</div>
          <div style={styles.reportDescription}>Total learning occurrences</div>
        </div>
      </div>

      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>Top Failure Patterns</h3>
        {report.topFailurePatterns?.length === 0 ? (
          <div style={styles.emptyState}>No failure patterns yet</div>
        ) : (
          <div>
            {report.topFailurePatterns?.map((pattern: any, idx: number) => (
              <div key={idx} style={styles.patternItem}>
                <div style={styles.patternName}>{pattern.pattern}</div>
                <div style={styles.patternStats}>
                  Occurrences: {pattern.occurrences} | Confidence:{' '}
                  {(pattern.confidence * 100).toFixed(1)}%
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>Top Strategies</h3>
        {report.topStrategies?.length === 0 ? (
          <div style={styles.emptyState}>No strategies yet</div>
        ) : (
          <div>
            {report.topStrategies?.map((strategy: any, idx: number) => (
              <div key={idx} style={styles.strategyItem}>
                <div style={styles.strategyName}>{strategy.strategy}</div>
                <div style={styles.strategyBar}>
                  <div
                    style={{
                      width: `${strategy.successRate * 100}%`,
                      height: '20px',
                      backgroundColor: '#4caf50',
                      borderRadius: '3px',
                    }}
                  />
                </div>
                <div style={styles.strategyLabel}>
                  {(strategy.successRate * 100).toFixed(1)}% success rate
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * PersistenceStatusPanel - Show persistence status and controls
 */
export const PersistenceStatusPanel: React.FC<{
  workflowCoordinator: LearningWorkflowCoordinator;
  memoryStore: MemoryStore;
  onSave?: () => void;
}> = ({ workflowCoordinator, memoryStore, onSave }) => {
  const [state, setState] = useState(workflowCoordinator.getState());
  const [saveInProgress, setSaveInProgress] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setState(workflowCoordinator.getState());
    }, 2000);

    return () => clearInterval(interval);
  }, [workflowCoordinator]);

  const handleManualSave = async () => {
    setSaveInProgress(true);
    await workflowCoordinator.saveMemories(memoryStore);
    setSaveInProgress(false);
    onSave?.();
  };

  const handleExport = async (format: 'json' | 'csv' | 'markdown') => {
    await workflowCoordinator.exportMemories(memoryStore, format);
  };

  return (
    <div style={styles.statusContainer}>
      <h2 style={styles.title}>Persistence Status</h2>

      <div style={styles.statusInfo}>
        <div style={styles.statusRow}>
          <span>Status:</span>
          <span style={styles.statusBadge}>{state.workflow.status.toUpperCase()}</span>
        </div>

        <div style={styles.statusRow}>
          <span>Tasks Processed:</span>
          <span>{state.workflow.tasksProcessedSinceLastSave}</span>
        </div>

        <div style={styles.statusRow}>
          <span>Learning Events:</span>
          <span>{state.workflow.learningEventsThisSession}</span>
        </div>

        <div style={styles.statusRow}>
          <span>Last Save:</span>
          <span>
            {state.persistence.lastSaveTime > 0
              ? new Date(state.persistence.lastSaveTime).toLocaleString()
              : 'Never'}
          </span>
        </div>
      </div>

      <div style={styles.buttonGroup}>
        <button
          onClick={handleManualSave}
          disabled={saveInProgress}
          style={styles.button}
        >
          {saveInProgress ? 'Saving...' : 'Save Memories Now'}
        </button>

        <button onClick={() => handleExport('json')} style={styles.button}>
          Export JSON
        </button>

        <button onClick={() => handleExport('markdown')} style={styles.button}>
          Export Markdown
        </button>

        <button onClick={() => handleExport('csv')} style={styles.button}>
          Export CSV
        </button>
      </div>

      {state.workflow.persistenceErrors.length > 0 && (
        <div style={styles.errorSection}>
          <div style={styles.errorTitle}>Recent Errors:</div>
          {state.workflow.persistenceErrors.slice(-3).map((error, idx) => (
            <div key={idx} style={styles.errorItem}>
              {error}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// Styles
const styles: Record<string, React.CSSProperties> = {
  statsContainer: {
    padding: '20px',
    backgroundColor: '#f5f5f5',
    borderRadius: '8px',
    marginBottom: '20px',
  },
  title: {
    fontSize: '18px',
    fontWeight: 'bold',
    marginTop: 0,
    marginBottom: '15px',
    color: '#333',
  },
  statsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
    gap: '10px',
    marginBottom: '15px',
  },
  statCard: {
    backgroundColor: 'white',
    padding: '15px',
    borderRadius: '6px',
    border: '1px solid #ddd',
    textAlign: 'center',
  },
  statLabel: {
    fontSize: '12px',
    color: '#666',
    marginBottom: '8px',
  },
  statValue: {
    fontSize: '24px',
    fontWeight: 'bold',
    color: '#2196f3',
  },
  lastSaveInfo: {
    fontSize: '12px',
    color: '#999',
    marginTop: '10px',
  },
  browserContainer: {
    padding: '20px',
    backgroundColor: '#f5f5f5',
    borderRadius: '8px',
  },
  controls: {
    display: 'flex',
    gap: '10px',
    marginBottom: '15px',
    flexWrap: 'wrap',
  },
  select: {
    padding: '8px',
    borderRadius: '4px',
    border: '1px solid #ddd',
    fontFamily: 'inherit',
  },
  filterInput: {
    flex: 1,
    minWidth: '200px',
    padding: '8px',
    borderRadius: '4px',
    border: '1px solid #ddd',
    fontFamily: 'inherit',
  },
  button: {
    padding: '8px 16px',
    backgroundColor: '#2196f3',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  memoryList: {
    maxHeight: '600px',
    overflowY: 'auto',
    marginBottom: '15px',
  },
  memoryItem: {
    backgroundColor: 'white',
    padding: '12px',
    marginBottom: '8px',
    borderRadius: '4px',
    border: '1px solid #ddd',
  },
  memoryContent: {
    margin: 0,
    fontSize: '12px',
    overflowX: 'auto',
  },
  emptyState: {
    padding: '30px',
    textAlign: 'center',
    color: '#999',
  },
  loadingState: {
    padding: '30px',
    textAlign: 'center',
    color: '#666',
  },
  errorState: {
    padding: '30px',
    textAlign: 'center',
    color: '#d32f2f',
  },
  footer: {
    fontSize: '12px',
    color: '#999',
  },
  reportContainer: {
    padding: '20px',
    backgroundColor: '#f5f5f5',
    borderRadius: '8px',
  },
  reportGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    gap: '15px',
    marginBottom: '20px',
  },
  reportCard: {
    backgroundColor: 'white',
    padding: '20px',
    borderRadius: '6px',
    border: '1px solid #ddd',
    textAlign: 'center',
  },
  reportLabel: {
    fontSize: '14px',
    color: '#666',
    marginBottom: '8px',
  },
  reportValue: {
    fontSize: '32px',
    fontWeight: 'bold',
    color: '#2196f3',
    marginBottom: '8px',
  },
  reportDescription: {
    fontSize: '12px',
    color: '#999',
  },
  section: {
    marginBottom: '20px',
  },
  sectionTitle: {
    fontSize: '14px',
    fontWeight: 'bold',
    marginTop: 0,
    marginBottom: '10px',
    color: '#333',
  },
  patternItem: {
    backgroundColor: 'white',
    padding: '12px',
    marginBottom: '8px',
    borderRadius: '4px',
    border: '1px solid #ddd',
  },
  patternName: {
    fontWeight: 'bold',
    marginBottom: '4px',
  },
  patternStats: {
    fontSize: '12px',
    color: '#666',
  },
  strategyItem: {
    backgroundColor: 'white',
    padding: '12px',
    marginBottom: '8px',
    borderRadius: '4px',
    border: '1px solid #ddd',
  },
  strategyName: {
    fontWeight: 'bold',
    marginBottom: '8px',
  },
  strategyBar: {
    marginBottom: '4px',
  },
  strategyLabel: {
    fontSize: '12px',
    color: '#666',
  },
  statusContainer: {
    padding: '20px',
    backgroundColor: '#f5f5f5',
    borderRadius: '8px',
  },
  statusInfo: {
    backgroundColor: 'white',
    padding: '15px',
    borderRadius: '6px',
    border: '1px solid #ddd',
    marginBottom: '15px',
  },
  statusRow: {
    display: 'flex',
    justifyContent: 'space-between',
    paddingBottom: '8px',
    borderBottom: '1px solid #eee',
    fontSize: '14px',
  },
  statusBadge: {
    padding: '4px 8px',
    backgroundColor: '#4caf50',
    color: 'white',
    borderRadius: '4px',
    fontSize: '12px',
  },
  buttonGroup: {
    display: 'flex',
    gap: '8px',
    flexWrap: 'wrap',
    marginBottom: '15px',
  },
  errorSection: {
    backgroundColor: '#ffebee',
    padding: '12px',
    borderRadius: '4px',
    border: '1px solid #ffcdd2',
  },
  errorTitle: {
    fontWeight: 'bold',
    color: '#d32f2f',
    marginBottom: '8px',
  },
  errorItem: {
    fontSize: '12px',
    color: '#d32f2f',
    marginBottom: '4px',
  },
};

export default {
  MemoryStatsDashboard,
  MemoryBrowser,
  LearningReportPanel,
  PersistenceStatusPanel,
};
