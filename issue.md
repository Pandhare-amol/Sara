(.venv-1) PS D:\project\new_jarvis\Sara\myraa-ai-assistant> npm run dev

> sara@1.0.0 dev
> tsx server.ts

◇ injected env (1) from .env // tip: ◈ secrets for agents [www.dotenvx.com]
[Server] Running on http://localhost:3000
[Desktop Agent] Not detected. Auto-starting...
[Desktop Agent] Auto-spawned via Python (PID 14120).
[Desktop Agent] Online after 4s â€” 52 tools available.
Client WebSocket connected to /live
[Sara Interrupted!]
[Sara Interrupted!]
[Sara Interrupted!]
[Function Call]: runPythonScript {
  path: 'C:\\Users\\Admin\\Desktop\\sara-ai-assistant\\check_agents.py'
}
[Desktop Agent] Routing runPythonScript to Python backend...
[Desktop Agent] Error for runPythonScript: Path 'C:\Users\Admin\Desktop\sara-ai-assistant\check_agents.py' is outside SARA's safe folders (Desktop, Documents, Downloads, Pictures, Music, Videos, home, and the project folder). Pass allow_anywhere=true only if you really mean it.
[Function Call]: openApplication { name: 'notepad.py' }
[Desktop Agent] Routing openApplication to Python backend...
[Desktop Agent] Error for openApplication: Unrecognized application 'notepad.py'. Supported: Calculator, Command Prompt, File Explorer, Google Chrome, Microsoft Edge, Notepad, Paint, PowerShell, Settings, Snipping Tool, Task Manager, Visual Studio Code, WordPad.
[Function Call]: openApplication { name: 'notepad' }
[Desktop Agent] Routing openApplication to Python backend...
[Function Call]: closeApplication { name: 'notepad' }
[Desktop Agent] Routing closeApplication to Python backend...
[Function Call]: closeApplication { name: 'notepad' }
[Desktop Agent] Routing closeApplication to Python backend...
[Sara Interrupted!]
[Sara Interrupted!]
[Sara Interrupted!]
[Function Call]: searchYouTube { query: 'Arijit Singh songs' }
[Desktop Agent] Routing searchYouTube to Python backend...
[Function Call]: openWebsite { name: 'youtube' }
[Desktop Agent] Routing openWebsite to Python backend...
[Sara Interrupted!]
[Function Call]: browserTabAction { action: 'new', url: 'google.com' }
[Sara Interrupted!]
[Sara Interrupted!]
[Function Call]: browserClick { description: 'Play first search result', selector: '#video-title' }
[Sara Interrupted!]
[Sara Interrupted!]
[Function Call]: browserTabAction { action: 'close' }
[Function Call]: openFolder {}
[Desktop Agent] Routing openFolder to Python backend...
[Desktop Agent] Error for openFolder: Parameter 'name' or 'path' is required.
[Function Call]: openFolder { name: 'home' }
[Desktop Agent] Routing openFolder to Python backend...
[Function Call]: openFolder { name: 'downloads' }
[Desktop Agent] Routing openFolder to Python backend...
[Sara Interrupted!]
[Sara Interrupted!]
[Sara Interrupted!]
[Function Call]: minimizeWindow {}
[Desktop Agent] Routing minimizeWindow to Python backend...
[Sara Interrupted!]
[Sara Interrupted!]
[Sara Interrupted!]
[Sara Interrupted!]
[Function Call]: moveFile {
  destination: 'C:/Users/k8673/Downloads/logo_copy.png',
  path: 'C:/Users/k8673/Downloads/logo.png'
}
[Desktop Agent] Routing moveFile to Python backend...
[Desktop Agent] Error for moveFile: File does not exist: C:\Users\k8673\Downloads\logo.png
[Function Call]: openFolder { name: 'downloads' }
[Desktop Agent] Routing openFolder to Python backend...
[Sara Interrupted!]
[Function Call]: listFiles { pattern: 'logo.png', name: 'downloads' }
[Desktop Agent] Routing listFiles to Python backend...
Gemini Live session closed
Client disconnected, closing Gemini session
Client WebSocket connected to /live
Client disconnected, closing Gemini session
Gemini Live session closed
Client WebSocket connected to /live
Client WebSocket connected to /live
Client WebSocket connected to /live
[Sara Interrupted!]
[Sara Interrupted!]
[Sara Interrupted!]
[Sara Interrupted!]
[Sara Interrupted!]
[Sara Interrupted!]
[Function Call]: moveFile {
  path: 'C:\\Users\\MSI\\Downloads\\logo.png',
  destination: 'C:\\Users\\Admin\\Desktop\\sara-ai-assistant'
}
[Desktop Agent] Routing moveFile to Python backend...
[Desktop Agent] Error for moveFile: File does not exist: C:\Users\MSI\Downloads\logo.png
[Function Call]: copySelected {}
[Desktop Agent] Routing copySelected to Python backend...
(.venv-1) PS D:\project\new_jarvis\Sara\myraa-ai-assistant> 