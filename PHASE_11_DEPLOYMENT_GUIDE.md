# Phase 11: Production Build & Deployment Guide

## Overview

This guide covers building SARA for production, deploying to target environments, and verifying runtime behavior with the real desktop agent integration.

## Pre-Deployment Checklist

### Code State
- ✅ All 11 cognitive APIs operational
- ✅ Real desktop agent integration complete
- ✅ End-to-end learning pipeline verified
- ✅ No compilation errors
- ✅ Unit tests passing

### Environment Requirements

**Local Build Machine:**
- Node.js 18+ (LTS recommended)
- Python 3.10+ (for desktop agent)
- npm 9+
- Git

**Production Server:**
- Windows Server 2019+ or Windows 10/11 Pro
- Node.js 18+ runtime (no development tools needed)
- Python 3.10+ runtime (for desktop agent)
- 8GB RAM minimum, 16GB recommended
- 2GB disk space minimum

### API Keys & Secrets

Before building, ensure these are configured:

1. **GEMINI_API_KEY** - Google Gemini API key for AI planning
2. **SARA_ADMIN_TOKEN** - Security token for admin endpoints (generate unique production value)
3. **APP_URL** (optional) - Public URL if hosting on cloud/server

---

## Build Process

### Step 1: Verify Build Configuration

```bash
# Navigate to project
cd d:\project\new_jarvis\Sara\myraa-ai-assistant

# Verify all dependencies installed
npm install

# Check TypeScript compilation
npm run lint

# Expected output: 0 new errors
```

### Step 2: Create Production Build

```bash
# Build frontend (Vite) + backend (esbuild)
npm run build

# This produces:
# - dist/index.html (React SPA)
# - dist/assets/* (React bundles)
# - dist/server.cjs (Bundled Node.js server)
# - dist/server.cjs.map (Source maps for debugging)
```

**Build Output Structure:**
```
dist/
├── index.html              # Entry point for browser
├── assets/
│   ├── index-*.js         # React main bundle
│   ├── index-*.css        # Styles
│   └── [vendor-*.js]      # Dependency chunks
├── server.cjs             # Node.js server bundle
└── server.cjs.map         # Source maps
```

### Step 3: Verify Build Integrity

```bash
# Verify dist folder contents
Get-ChildItem -Path dist -Recurse | Measure-Object

# Should show:
# - 1x index.html
# - 1x server.cjs
# - Multiple asset files
# - Total size: ~3-5MB
```

---

## Production Deployment

### Option 1: Windows Server Standalone Deployment

**Target Environment:** Windows Server with Node.js + Python installed

#### Setup Steps:

1. **Create deployment directory:**
```bash
# On production server
mkdir C:\SARA
mkdir C:\SARA\data
mkdir C:\SARA\logs
```

2. **Copy production files:**
```bash
# Copy only necessary files
Copy-Item dist C:\SARA\dist -Recurse
Copy-Item package.json C:\SARA\
Copy-Item .env.production C:\SARA\.env  # Configured with production secrets
```

3. **Install runtime dependencies:**
```bash
cd C:\SARA

# Install Node dependencies (production only)
npm install --production

# Verify desktop agent Python
python --version  # Should be 3.10+
pip install uvicorn fastapi  # Desktop agent deps
```

4. **Create .env for production:**
```
GEMINI_API_KEY="YOUR_PROD_GEMINI_KEY"
SARA_ADMIN_TOKEN="YOUR_SECURE_PROD_TOKEN"
NODE_ENV="production"
PORT="3000"
DESKTOP_AGENT_URL="http://127.0.0.1:8765"
```

5. **Test production startup:**
```bash
# Start server
npm start

# In another terminal, verify
curl http://localhost:3000

# Should return index.html (SPA)
curl http://localhost:3000/cognitive/memory/stats

# Should return JSON with memory data
```

### Option 2: Windows Service Auto-Start

**Setup automatic startup on server boot:**

1. **Create startup script (C:\SARA\start.bat):**
```batch
@echo off
cd /d C:\SARA
node dist\server.cjs
```

2. **Register as Windows Service using NSSM:**
```bash
# Download NSSM from https://nssm.cc/download
nssm install SaraAI C:\SARA\start.bat
nssm start SaraAI

# Verify
nssm status SaraAI  # Should show SERVICE_RUNNING
```

3. **Configure auto-recovery:**
```bash
# Auto-restart on failure
nssm set SaraAI AppRestartDelay 5000
nssm set SaraAI AppExit Default Restart
```

### Option 3: Docker Containerization (Advanced)

**Create Dockerfile for easy deployment:**

```dockerfile
FROM node:18-windows

WORKDIR /app

# Copy production build
COPY dist dist/
COPY package.json .
COPY .env .env

# Install dependencies
RUN npm install --production

# Install Python for desktop agent
RUN chocolatey install python310

# Expose ports
EXPOSE 3000 8765

# Start server
CMD ["npm", "start"]
```

Build and run:
```bash
docker build -t sara-ai:1.0 .
docker run -p 3000:3000 -p 8765:8765 sara-ai:1.0
```

---

## Post-Deployment Verification

### 1. Server Health Check

```bash
# Check server is running
curl http://localhost:3000/

# Expected: Returns HTML (index.html)
```

### 2. API Endpoints Verification

```bash
# Test cognitive API
$response = Invoke-RestMethod -Uri "http://localhost:3000/cognitive/memory/stats"
Write-Host "Memory stats: $($response.stats.episodic.total) episodes"

# Test desktop agent integration
$response = Invoke-RestMethod -Uri "http://localhost:3000/cognitive/task/execute" `
  -Method POST `
  -Body (ConvertTo-Json @{
    taskId = "deploy-verify"
    goal = "Verify deployment"
    userInput = "Test production environment"
  }) `
  -ContentType "application/json"

Write-Host "Task executed: $($response.ok)"
```

### 3. Desktop Agent Verification

```bash
# Check desktop agent health
curl http://localhost:8765/health

# Expected: JSON response with agent status
```

### 4. Memory Persistence Verification

```bash
# Verify data files created
ls C:\SARA\data\

# Should show:
# - episodic_memories.json
# - semantic_memories.json
# - settings.json
```

### 5. Log Review

```bash
# Check for errors in logs
tail -f C:\SARA\logs\sara.log

# Look for:
# - Server listening on 3000
# - Desktop agent connected
# - Cognitive routes mounted
```

---

## Production Configuration

### Environment Variables

**Required for production:**
```
GEMINI_API_KEY=<your-api-key>          # Google Gemini API key
SARA_ADMIN_TOKEN=<secure-token>        # Admin authentication
NODE_ENV=production                     # Enable production mode
```

**Optional:**
```
PORT=3000                               # Server port
DESKTOP_AGENT_URL=http://127.0.0.1:8765  # Agent endpoint
LOG_LEVEL=info                          # Logging level
```

### Security Considerations

1. **API Key Management:**
   - Never commit API keys to git
   - Use environment variables only
   - Rotate keys regularly
   - Use different keys for dev/prod

2. **Admin Token:**
   - Generate cryptographically secure token
   - Minimum 32 characters
   - Use different token per environment

3. **Network Security:**
   - Desktop agent runs on localhost only (127.0.0.1:8765)
   - Main API on 0.0.0.0:3000
   - Use firewall to restrict API access if needed
   - Consider reverse proxy (nginx/IIS) for production

4. **Data Security:**
   - Memory files stored in data/ directory
   - Consider encrypting data files at rest
   - Regular backups of data directory

---

## Performance Tuning

### For Production Scale

**Node.js optimization:**
```bash
# Use cluster mode for multiple cores
NODE_ENV=production pm2 start npm --name "sara" -- start

# Or with NODE options
set NODE_OPTIONS=--max-old-space-size=4096
npm start
```

**Desktop Agent optimization:**
```bash
# Adjust uvicorn workers if needed
uvicorn desktop_agent.main:app --host 127.0.0.1 --port 8765 --workers 4
```

### Monitoring in Production

**Key metrics to monitor:**
- CPU usage (should stay < 40% idle)
- Memory usage (should stay < 50% available)
- API response times (should stay < 1s for most endpoints)
- Desktop agent response times (1-5s typical)
- Error rates (should be < 1%)

---

## Rollback Procedures

If issues occur in production:

1. **Stop current version:**
```bash
npm run sara:stop  # or
nssm stop SaraAI   # if using Windows Service
```

2. **Keep previous build:**
```bash
# Before building new version
Copy-Item dist dist.backup -Recurse
```

3. **Restore backup:**
```bash
Remove-Item dist
Copy-Item dist.backup dist -Recurse
npm start
```

4. **Check logs:**
```bash
Get-Content logs/sara.log | Select-Object -Last 50
```

---

## Continuous Deployment (Optional)

**Automated deployment pipeline:**

1. **GitHub Actions (if using GitHub):**
```yaml
name: Deploy to Production
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
      - run: npm install
      - run: npm run lint
      - run: npm run build
      - run: npm test
      - name: Deploy
        run: |
          xcopy dist \\prod-server\SARA\dist /Y
          ssh admin@prod-server "npm run sara:restart"
```

2. **PowerShell Deployment Script:**
```powershell
param(
    [string]$DeployServer = "prod-server.local",
    [string]$BuildPath = ".\dist"
)

# Build
npm run build

# Copy to server
Copy-Item -Path $BuildPath -Destination "\\$DeployServer\C$\SARA\dist" -Recurse -Force

# Restart service
Invoke-Command -ComputerName $DeployServer -ScriptBlock {
    nssm restart SaraAI
}

Write-Host "Deployment complete!"
```

---

## Troubleshooting

### Issue: Port 3000 already in use

```bash
# Find what's using port 3000
netstat -ano | findstr :3000

# Kill the process
taskkill /PID <PID> /F

# Or use different port
set PORT=3001
npm start
```

### Issue: Desktop agent not connecting

```bash
# Verify Python is installed
python --version

# Check agent can start
cd desktop_agent
python -m uvicorn main:app --port 8765

# If fails, install dependencies
pip install uvicorn fastapi pyaudio pynput
```

### Issue: Gemini API key not working

```bash
# Verify key is set in .env
type .env | findstr GEMINI_API_KEY

# Test API key
curl -X POST https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"test"}]}]}' \
  -H "x-goog-api-key: YOUR_KEY"
```

### Issue: High memory usage

```bash
# Check memory consumption
Get-Process node | Select-Object ProcessName, WorkingSet

# Increase heap size
set NODE_OPTIONS=--max-old-space-size=8192
npm start

# Monitor consolidation (may spike during learning)
```

---

## Summary

**Phase 11 Deployment Checklist:**

- [ ] Code built successfully (npm run build)
- [ ] Build artifacts verified (dist/ directory)
- [ ] .env.production configured with secrets
- [ ] Production server prepared
- [ ] Dependencies installed on production server
- [ ] Server started successfully
- [ ] API endpoints responding
- [ ] Desktop agent connected
- [ ] Memory files persisting
- [ ] Monitoring configured
- [ ] Rollback procedure documented
- [ ] Admin token secured

**Production Status:** Ready for deployment

**Next: Phase 12 - Advanced Learning Features**
