# Ecosystem Integration Layer

All integrations are isolated under `agi/` and opt-in. Existing SARA modules are not imported or modified.

- `ApiGateway`: versioned routes, per-key rate limiting, and usage snapshots.
- `PriorityJobQueue`: bounded asynchronous jobs with priority, status, retries, and failure state.
- `ReadOnlyDatabaseAssistant`: schema port and parameterized SELECT-only execution guard.
- `StructuredLogger`, `MetricsRegistry`, `ObservabilityBridge`: correlation-aware logs, p50/p95/p99 metrics, and Prometheus text.
- `AuditTrail`, `ConsentManager`, `RetentionPolicy`, `validateExternalUrl`: audit, consent, retention, and SSRF protections.
- `ConnectorRegistry`, `CloudModelAdapter`, `CicdPort`, `MonitoringPort`: ports for Salesforce/Zendesk/Slack/calendar/storage, AWS/GCP/Azure/custom clouds, CI/CD, and monitoring systems.
- `SaraIntegrationLayer`: opt-in mapping for search, recommendations, analytics, notifications, workflows, forms, reports, and troubleshooting.
- `SaraSuccessMetrics`: task time, satisfaction, adoption, errors prevented, and cost savings.
- `runAgiCli`: lightweight local testing/debugging entry point.
- `BusinessAssessmentService`: evidence-based current-state, SWOT, positioning, competitor, strategy, risk, and implementation planning.
- `KpiTracker`: target-aware KPI status, snapshots, and adjustment recommendations.

Production deployments should supply authenticated adapters for Redis, real databases, cloud SDKs, queues, model providers, and SIEM/alert systems. The layer intentionally does not perform external side effects by default.

## Strategy Data Rules

Business assessments require supplied evidence with a source, confidence, and verification state. Missing competitor, customer, financial, or market evidence is reported as an evidence gap; it is never filled with invented facts. KPI recommendations require a named owner, a measurable target, an observed value, a source, and a review trigger before they should drive an operating decision.
