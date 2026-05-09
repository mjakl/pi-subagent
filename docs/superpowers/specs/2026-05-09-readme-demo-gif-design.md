# README Demo GIF Design

**Date:** 2026-05-09
**Repository:** `~/Projects/pi-subagent/.worktrees/subagent-model-ui`
**Scope:** Small documentation/media update
**Goal:** Add a high-readability animated GIF under the README title to show how pi-subagent looks in use.

---

## Problem Statement

The README currently starts with text only. The project would benefit from a visual demonstration near the top so readers can immediately understand what the extension looks like and how subagent runs appear in Pi.

---

## User-Approved Requirements

- Use the source video:
  - `/home/clt/Videos/Screencasts/Screencast from 05-09-2026 04:49:52 AM.webm`
- Convert it to a **GIF** for GitHub README compatibility
- Optimize for **text readability/sharpness**, not minimum file size
- Copy the generated asset into the repository
- Place the visual **immediately under `# Pi Subagent`**
- Use the GIF **without a caption**
- Keep the rest of the README unchanged unless small spacing adjustments are needed

---

## Recommended Approach

Create a README-specific GIF asset from the provided `.webm` using `ffmpeg`, store it in a repository-owned assets directory, and embed it with standard Markdown image syntax directly below the README title.

This is preferred over keeping the original video because GIFs are more reliable for GitHub README display and require no extra explanation or click-through.

---

## Asset Plan

### Source
- `/home/clt/Videos/Screencasts/Screencast from 05-09-2026 04:49:52 AM.webm`

### Destination
- `docs/assets/subagent-demo.gif`

### Conversion Goals
- Prioritize crisp terminal text
- Keep the animation smooth enough to show the subagent flow
- Accept a somewhat larger file size in exchange for readability

---

## README Placement

Insert the GIF directly below:

```md
# Pi Subagent
```

Use a plain Markdown embed:

```md
![Pi Subagent demo](docs/assets/subagent-demo.gif)
```

No caption or explanatory text is required in this update.

---

## Scope

### In Scope
- Generate the GIF from the provided `.webm`
- Add the GIF to the repository
- Update `README.md` to display it near the top

### Out of Scope
- Rewriting README copy beyond the embed insertion
- Adding multiple demo assets
- Adding captions, annotations, or callouts
- Keeping the original video in the repository unless needed during generation

---

## Risks and Mitigations

### Risk: GIF becomes too large
**Mitigation:** Prefer readability first, but keep dimensions and frame rate reasonable.

### Risk: text looks blurry after conversion
**Mitigation:** Use an ffmpeg conversion tuned for crisp terminal text rather than aggressive compression.

### Risk: asset location clutters the repo root
**Mitigation:** Store the file under `docs/assets/`.

---

## Success Criteria

This change is successful when:

1. `docs/assets/subagent-demo.gif` exists in the repository
2. `README.md` embeds it directly under the title
3. The GIF renders on GitHub as a top-of-page demo
4. The text in the GIF remains easy to read
