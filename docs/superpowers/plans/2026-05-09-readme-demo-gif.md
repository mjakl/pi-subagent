# README Demo GIF Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a high-readability animated GIF under the README title so GitHub visitors immediately see how pi-subagent looks in use.

**Architecture:** Convert the approved `.webm` screencast into a repository-owned GIF asset optimized for readable terminal text, store it under `docs/assets/`, and embed it directly below the `# Pi Subagent` heading. Keep the README change minimal and avoid unrelated copy edits.

**Tech Stack:** Markdown, ffmpeg, Git, GitHub README image rendering

---

## File structure

- **Create:** `docs/assets/subagent-demo.gif`
  - Repository-owned animated GIF asset generated from the approved screencast.
- **Modify:** `README.md`
  - Insert the GIF immediately below the main title using standard Markdown image syntax.

---

### Task 1: Generate and verify the README GIF asset

**Files:**
- Create: `docs/assets/subagent-demo.gif`

- [ ] **Step 1: Generate the GIF from the approved screencast**

Run:
```bash
mkdir -p docs/assets
ffmpeg -y \
  -i "/home/clt/Videos/Screencasts/Screencast from 05-09-2026 04:49:52 AM.webm" \
  -vf "fps=12,scale=900:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=full[p];[s1][p]paletteuse=dither=sierra2_4a" \
  docs/assets/subagent-demo.gif
```

Expected:
- `docs/assets/subagent-demo.gif` is created successfully
- conversion completes without ffmpeg errors

- [ ] **Step 2: Verify the generated asset exists and has a reasonable size**

Run:
```bash
ls -lh docs/assets/subagent-demo.gif
file docs/assets/subagent-demo.gif
```

Expected:
- `ls` shows the file exists
- `file` reports `GIF image data`

- [ ] **Step 3: Visually inspect the GIF for text readability**

Run:
```bash
xdg-open docs/assets/subagent-demo.gif
```

Expected:
- the GIF opens in the default image viewer
- terminal text is readable
- motion is smooth enough to understand the subagent flow

- [ ] **Step 4: Commit the generated asset**

Run:
```bash
git add docs/assets/subagent-demo.gif
git commit -m "Add README demo GIF asset"
```

Expected:
- a commit is created containing only the generated GIF asset

---

### Task 2: Embed the GIF under the README title

**Files:**
- Modify: `README.md`
- Use: `docs/assets/subagent-demo.gif`

- [ ] **Step 1: Write the README change**

Update the top of `README.md` from:

```md
# Pi Subagent

**Delegate tasks to specialized subagents with configurable context modes (`spawn` / `fork`).**
```

to:

```md
# Pi Subagent

![Pi Subagent demo](docs/assets/subagent-demo.gif)

**Delegate tasks to specialized subagents with configurable context modes (`spawn` / `fork`).**
```

- [ ] **Step 2: Verify the README diff is minimal**

Run:
```bash
git diff -- README.md
```

Expected:
- only the GIF embed is added directly under the title
- no unrelated README copy changes appear

- [ ] **Step 3: Verify the asset is referenced correctly**

Run:
```bash
rg -n "subagent-demo\.gif|# Pi Subagent" README.md
```

Expected:
- `README.md` contains `# Pi Subagent`
- `README.md` contains `![Pi Subagent demo](docs/assets/subagent-demo.gif)` immediately below it

- [ ] **Step 4: Commit the README embed change**

Run:
```bash
git add README.md
git commit -m "Add README demo GIF"
```

Expected:
- a commit is created containing only the README embed change

---

### Task 3: Final verification for GitHub-readiness

**Files:**
- Verify: `README.md`
- Verify: `docs/assets/subagent-demo.gif`

- [ ] **Step 1: Preview the top of the README locally**

Run:
```bash
sed -n '1,12p' README.md
```

Expected:
- title appears first
- GIF embed appears directly under the title
- one-line description remains below the GIF

- [ ] **Step 2: Verify repository status is clean except intended changes**

Run:
```bash
git status --short
```

Expected:
- no unexpected files are present
- only the intended README/GIF changes are staged or committed

- [ ] **Step 3: Push the branch updates**

Run:
```bash
git push
```

Expected:
- branch updates are pushed successfully

- [ ] **Step 4: Check the GitHub README rendering in the browser**

Open the branch or PR page in GitHub and verify:
- the GIF appears directly under the title
- the animation plays correctly
- the text remains readable

- [ ] **Step 5: Commit any final micro-adjustment only if needed**

If spacing or asset choice still needs a tiny correction after GitHub preview, make that one adjustment and commit with one of:

```bash
git commit -m "Tweak README demo GIF placement"
```

or

```bash
git commit -m "Regenerate README demo GIF"
```

Only do this step if the GitHub rendering actually shows a problem.

---

## Spec coverage check

- **Use the approved `.webm` source:** implemented in Task 1 conversion command.
- **Convert to GIF for GitHub compatibility:** implemented in Task 1.
- **Optimize for readability/sharpness:** handled by the ffmpeg conversion settings in Task 1 and visual inspection in Task 1 Step 3.
- **Copy asset into the repository:** handled by creating `docs/assets/subagent-demo.gif` in Task 1.
- **Place it directly under the title:** handled in Task 2.
- **No caption:** enforced by the exact Markdown snippet in Task 2.
- **Keep README changes minimal:** verified in Task 2 Step 2.

## Placeholder scan

No `TBD`, `TODO`, or deferred steps remain. Every file path, command, and README snippet is explicit.

## Type consistency check

The plan consistently uses:
- `docs/assets/subagent-demo.gif`
- `README.md`
- `![Pi Subagent demo](docs/assets/subagent-demo.gif)`

No conflicting filenames or embed paths are introduced.
