# Setup guide (portable, for the Mac that runs Penpot)

Canvas Crew has **no dependencies**. You need Node 20 or newer and nothing else.

## 1. Check Node

```bash
node -v      # needs v20 or higher
```

If it is older, install Node 20+ (`brew install node`).

## 2. Unzip

```bash
cd ~/experiments
unzip penpot-canvas-crew.zip
cd penpot-canvas-crew
```

## 3. Configure

```bash
cp .env.example .env
```

Then edit `.env` and set two values.

**a) Your Penpot MCP URL.** In Penpot go to **Your account -> Integrations -> MCP Server**. Penpot shows a ready-made URL with your per-user key already appended. It looks like:

```
PENPOT_MCP_URL=http://192.168.68.59:9001/mcp/stream?userToken=eyJhbG...
```

If you are running the crew on the same machine as Penpot, `localhost` works instead of the LAN IP. Do not drop the `?userToken=` part: the MCP container always runs in multi-user mode and every file-touching call fails without it.

**b) Your inference key.**

```
PARTICLE_BASE_URL=https://api.particle.ai/v1
PARTICLE_API_KEY=your_key_here
```

Any OpenAI-compatible endpoint works. For a fully local run, point `PARTICLE_BASE_URL` at LM Studio (`http://127.0.0.1:1234/v1`) or Ollama (`http://127.0.0.1:11434/v1`) and use a model with vision for the critic.

## 4. Connect the plugin (the manual step, and the one that will bite you)

In Penpot: **open your design file**, then **File -> MCP Server -> Connect**. Leave that tab open.

**The important part: keep the Penpot window visible.** When you run the crew from a terminal on the same machine, the terminal window covers the browser, the browser freezes the occluded tab, and the plugin connection drops mid-run. This is the single most common failure and it is not a bug in your setup.

Set up before a run:

- Put the Penpot window **beside** the terminal, not behind it. Do not minimise it.
- Pin the Penpot tab.
- In Chrome, add your Penpot site under **Settings -> Performance -> "Always keep these sites active"**.

The crew now proves the plugin is attached *before* spending any model calls, and it retries for about 75 seconds per call while you click back. If you need longer:

```
CREW_RETRY_ATTEMPTS=12
CREW_RETRY_DELAY_MS=5000
```

What the two messages mean, if you see them:

- `The Penpot plugin tab has been frozen by the browser` - the tab is hidden. Bring the window forward.
- `No Penpot plugin is connected to this MCP session` - the plugin session dropped. Click into the Penpot tab, then re-run.

Neither means anything is misconfigured.

## 5. Verify before spending anything

```bash
npm run check
```

You want to see:

```
  connected: penpot 1.0.0
  tools: execute_code, high_level_overview, penpot_api_info, export_shape
  plugin: CONNECTED and responsive
  ...
  Routing: OK, every role has the capability it needs.
```

If the plugin line says NOT USABLE, do step 4 again. If routing reports problems, the named role needs a different model in `.env`.

## 6. Run it

```bash
npm run crew -- --brief "a pricing page for a local-first note taking app"
```

Takes roughly 1 to 3 minutes per round. When it finishes:

```bash
open runs/<the-run-directory>/report.html
```

The crew creates one board named `Crew` on the currently open page and recreates it each round. It does not touch anything else. To keep a run off your working design, make a copy of the file first or switch to an empty page.

## 7. See it work with no Penpot at all

```bash
npm run demo     # full run against mocks, writes a real report.html
npm test         # 32 tests
```

## Optional: save a version first

Penpot's own guidance for agent workflows: save a version from the **Versions** panel before letting an agent edit a file, or duplicate the file and let the agent work on the copy. Do that until you trust the crew with a file you care about.