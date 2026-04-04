# Claudex UI/UX Review

Review date: March 6, 2026

Basis for review:

- Current repository structure and app shell in `src/App.tsx`
- Primary UI components in `src/components/LeftRail.tsx`, `HeaderBar.tsx`, `BottomBar.tsx`, and `TerminalPanel.tsx`
- Supplied product screenshot

Blunt summary:

Claudex has the right product thesis and the right technical core. The UI does not yet match that ambition. It still feels like an internal wrapper around Claude CLI rather than a polished developer workstation. The biggest problem is structural: project navigation, thread management, terminal interaction, and utility controls are all competing at the same visual level. That creates constant micro-friction for exactly the user who is least tolerant of it: a fast, keyboard-heavy engineer juggling multiple contexts.

## Section 1 - Product Understanding

Claudex appears to be a local macOS control plane for Claude CLI sessions. It lets an engineer group AI work by project, persist thread/session history, reopen workspaces, attach files, and interact with Claude through an embedded terminal rather than raw Terminal.app tabs.

The primary user is a software engineer running several AI-assisted coding tasks across multiple repositories. This is not a casual chat user. It is a power user who wants persistent context, fast switching, low ceremony, and strong control over execution state.

The intended core workflow is likely:

1. Choose a project/workspace.
2. Open or create a thread within that project.
3. Read Claude output in a terminal-like surface.
4. Send follow-up instructions, attach files, switch branches, or open the repo externally.
5. Bounce between multiple active threads without losing state.

That is a strong workflow foundation. The current UI just does not present it with enough clarity or speed.

## Section 2 - Information Architecture Review

What is working:

- Grouping threads under projects is the correct top-level model.
- Threads are treated as durable objects rather than transient runs, which is the right mental model for real developer work.
- Local and remote workspaces in one system is strategically strong.

Where the structure breaks down:

- The app mixes global actions, workspace actions, thread actions, and session actions across three unrelated regions.
- The left rail is doing too much: app setup, project creation, search, thread creation, workspace management, and thread management all live there.
- The current hierarchy is visually ambiguous. Workspace cards, thread rows, and “New thread” rows are too similar, so scanning the rail is slower than it should be.
- “Project” and “workspace” are conceptually the same thing in the product, but the UI and code use both terms. That is avoidable cognitive drag.
- Search is labeled as thread search, but it also searches thread content. That is powerful, but the UI does not teach that capability.
- Important actions are hidden in context menus or hover states. That is acceptable for destructive or secondary actions, but not for core navigation.

Structural confusion:

- The selected project is not visually important enough compared to the selected thread.
- The header mostly reflects the currently selected thread, while the project rail behaves as the main navigation container. Those models are competing.
- The bottom bar includes git state, attachments, a rendering troubleshooting affordance, and security controls. Those do not belong to one coherent object.

Missing affordances:

- No clear “global switcher” for jumping between threads across projects.
- No clear “active threads” or “recent threads” view.
- No visible separation between navigation state and execution state.
- No obvious archive/history layer for old threads.

Recommendation:

Make the hierarchy explicit:

1. App/global layer: workspace switcher, command palette, app settings, updates.
2. Project layer: selected project, branch, open actions, project context.
3. Thread layer: thread list, create thread, pin/archive/filter.
4. Session layer: model, permissions, run state, terminal/transcript controls.

Right now those layers are interleaved instead of staged.

## Section 3 - Visual Hierarchy and Layout

The current layout has too many “important” elements.

Problems:

- The `Update` button is visually louder than the core workflow. That is backwards for a productivity app.
- The left rail is visually heavy. Nested rounded containers, repeated borders, and multiple toolbars make the navigation feel busy before the user even reads content.
- The terminal surface is dominant, which is correct, but it lacks a surrounding context frame that helps users understand what state they are in.
- The bottom bar is overloaded and reads like a junk drawer.
- “Display issue?” is visually adjacent to branch controls and execution permissions, which makes the whole lower area feel improvised.
- `Full access` is important and risky, but the control looks like a generic pill button. It does not communicate seriousness or state clearly enough.
- Time labels, unread dots, active highlight, and running indicators all compete in the thread rows. The signal is there, but the list becomes noisy at scale.

Eye flow issues:

- The eye is pulled from the left rail header buttons to the bright update button to the dark terminal body to the busy footer. There is no stable visual spine.
- The main call to action is unclear. Is the user supposed to select a thread, type in the terminal, use attachments, or manage the repo?

Recommendation:

- Reduce chrome in the sidebar and make it read like a native source list, not stacked cards.
- Move rare/global utilities out of the primary navigation strip.
- Turn the main header into a high-signal context bar: thread name, project, model, branch, run state, permission state.
- Give the composer its own clear interaction zone instead of making it share space with unrelated controls.

## Section 4 - Interaction Model

### Creating a thread

Current problems:

- New thread lives inside each project group, which is logically correct but operationally slow.
- There is no prominent global shortcut or quick-create flow.
- Auto-renaming a new thread from the first prompt is efficient, but it is invisible behavior. Users cannot predict or trust it.

Improvement:

- Add a primary `New Thread` action in a thread-list header, not as just another row in the list.
- Support `Cmd-N` for a new thread in the current project and `Cmd-Shift-N` for project creation.
- Show a temporary untitled thread state with inline title editing rather than silently renaming from prompt content.

### Switching threads

Current problems:

- Thread switching is possible, but not fast enough for a power user once the list grows.
- The thread list is dense and visually repetitive.
- There is no recent-thread switcher or quick-open pattern.

Improvement:

- Add a global quick switcher (`Cmd-K` or `Ctrl-Tab`) for recent threads across all projects.
- Support filters like `Active`, `Waiting`, `Unread`, `Pinned`, and `Archived`.
- Make the selected thread state more obvious and reduce row noise.

### Switching projects

Current problems:

- Project switching currently depends on scanning a large mixed rail and expanding/collapsing groups.
- Project reorder arrows add maintenance controls directly into navigation. That is visual noise for a low-frequency action.

Improvement:

- Move project reordering into a management view.
- Add a compact project switcher in the titlebar/toolbar.
- Consider a two-level navigation model: projects rail plus thread list pane.

### Attaching files

Current problems:

- Drag-and-drop support is good, but the composer copy is long and the attachment workflow is hidden until a thread is active.
- The plus button is generic and easy to ignore.

Improvement:

- Replace bare `+` with a paperclip affordance.
- Show attachment chips above the input/composer field, not as an incidental footer element.
- Provide a small inline preview of what will be sent.

### Interacting with model output

Current problems:

- Raw terminal output is powerful but cognitively expensive to scan.
- Claude responses, shell output, agent actions, and state updates all land in the same visual treatment.
- There is no review mode for diffs, changed files, or summarized steps.

Improvement:

- Keep the raw terminal, but add alternate views: `Transcript`, `Terminal`, and `Changes`.
- Add lightweight message landmarks for user prompts, Claude responses, and tool actions.
- Support collapsing verbose shell segments.

### Executing commands

Current problems:

- `Esc` to interrupt and double-`Esc` to kill is efficient but hidden.
- `Full access` is toggleable, but the consequences are not well explained in-context.
- Model/execution controls do not feel grouped as a single system.

Improvement:

- Introduce a compact run-control group in the header.
- Make interrupt/kill visible with keyboard hints.
- Turn `Full access` into a clearly contextual permission badge with a popover explaining scope and persistence.

## Section 5 - macOS Native Design Quality

Claudex is recognizably a custom desktop app, but it does not yet feel fully macOS-native.

Where it misses:

- The current top bar reads like a web app header, not a macOS toolbar/titlebar.
- The sidebar behaves more like a custom card list than a native source list.
- Pill buttons are overused, especially for utility actions.
- Some actions that should live in menu bar commands, toolbars, or contextual menus are rendered as always-visible buttons.
- Keyboard discoverability is weak.

Compared with strong macOS tools:

- Raycast is compact, keyboard-first, and merciless about hierarchy.
- Linear uses restraint: fewer borders, better spacing, clearer emphasis.
- Cursor keeps model/session context visible near the working surface.
- Arc makes contextual actions feel attached to the object in focus rather than spread everywhere.

Concrete macOS improvements:

- Move primary app controls into a real toolbar structure.
- Use a tighter, more native source-list sidebar rhythm.
- Prefer segmented/contextual controls over a field of unrelated pills.
- Add standard menu items and visible shortcut hints.
- Use system expectations for selection, focus, and sidebar grouping.

## Section 6 - Developer Workflow Optimization

For a developer tool, speed matters more than decoration.

Current friction:

- Too many actions require rail scanning and pointer travel.
- There is no true keyboard-first task switcher.
- Repo context is present, but fragmented.
- Terminal output is persistent, but not sufficiently reviewable.

Recommendations:

- `Cmd-K`: command palette for projects, threads, branches, permissions, settings, and recent actions.
- `Cmd-N`: new thread in current project.
- `Cmd-Shift-N`: add project.
- `/`: focus thread search when the sidebar is focused.
- `Ctrl-Tab`: quick switch among recent threads.
- `Cmd-B`: open branch switcher.
- `Cmd-.`: interrupt current session.

Quick actions to add:

- Pin thread
- Archive thread
- Duplicate thread into same project
- Move thread to another project
- Reopen last active thread
- Resume most recent interrupted session

Thread management improvements:

- Pinned threads at top
- Active/running threads section
- Archived threads separated from live work
- Multi-select and bulk archive/delete for cleanup
- Thread notes or labels for workstream categorization

Output review improvements:

- Inline file change summaries
- Diff review panel
- Collapsible command blocks
- Jump-to-last-user-prompt and jump-to-last-Claude-answer

## Section 7 - Specific UI Improvements

### Sidebar redesign

Current sidebar should be split conceptually into:

- Project rail
- Thread list

Recommended change:

- Far-left compact project rail with project names/icons and unread/running badges.
- Adjacent thread pane for the selected project only.
- Thread pane header should include project name, search, filters, and a prominent `New Thread`.

This immediately improves context switching and reduces nesting noise.

### Header redesign

Recommended header content:

- Thread title
- Project name/path
- Branch
- Model or agent
- Run state
- Permission state
- Open in Finder / Open in Terminal in a secondary cluster

The current `Update` button should not dominate this area. It should become a subtle badge in settings/help/app menu unless an update is actively required.

### Composer redesign

The bottom bar should become a proper composer area:

- Prompt entry and attachments together
- Secondary metadata below or above: context left, skill/agent, permission state
- Git/branch controls moved upward into project context, not embedded beside the composer

### Better thread creation UX

- `New Thread` should create a visible blank draft with focus in the composer.
- Let the user name the thread inline or accept an auto-suggested title after the first prompt, with clear editability.
- Offer templates: `Bug fix`, `Refactor`, `Code review`, `Investigation`.

### Improved terminal interaction

- Add tabs or a segmented control for `Transcript`, `Terminal`, and `Changes`.
- Keep follow-output controls close to the terminal scroll state, but make them lighter visually.
- Add “copy last command”, “copy last answer”, and “open changed files” affordances.

### Better visual grouping

- Project/repo state belongs together.
- Thread identity and session state belong together.
- Prompting, attachments, and send behavior belong together.
- Rare troubleshooting actions belong in help or settings, not in the main working strip.

## Section 8 - Power User Features

These are the kinds of features that would move Claudex toward Raycast/Cursor-class usefulness:

- Global command palette
- Recent thread switcher
- Inline diff review tied to a thread
- Session timeline with checkpoints and resume markers
- Thread pinning, labels, and smart grouping
- Project-level context packs and reusable instruction presets
- Quick compare between two thread outputs
- One-shot “spawn from current git diff” thread creation
- Per-thread working set of files
- “Open changed files in editor” from the current session
- Saved filters like `Waiting on Claude`, `Needs Review`, `High Risk`
- Keyboard-driven branch switcher and project switcher

## Section 9 - Top 5 Highest Impact Improvements

### 1. Split project navigation from thread navigation

Why it matters:

This is the single largest clarity win. Right now the left rail forces users to parse hierarchy and action density at the same time. Separating project selection from thread management would immediately improve scan speed, reduce nesting noise, and make context switching feel intentional.

### 2. Replace the bottom utility bar with a real composer

Why it matters:

The current footer mixes unrelated concerns. A dedicated composer would make prompting, attachments, permissions, and session state feel like one coherent interaction rather than four adjacent controls.

### 3. Add a command palette and quick switcher

Why it matters:

This product is for engineers. Keyboard-first navigation is not a bonus feature here; it is table stakes. Without it, Claudex will always feel slower than Terminal tabs, Raycast, or Cursor.

### 4. Add a review-oriented output mode alongside the terminal

Why it matters:

Raw PTY fidelity is valuable, but it is not enough for reading, comparing, and iterating on AI work. A transcript/changes layer would make Claude output usable for real review workflows instead of just session continuity.

### 5. Rebuild the header around current context, not generic utility buttons

Why it matters:

The selected thread, project, branch, run state, and permission state should define the top of the screen. That context bar is where confidence and speed come from. The current header underuses that space.

## Section 10 - Redesigned Layout Concept

Conceptual structure:

```text
+----------------------------------------------------------------------------------+
| Toolbar: Project Switcher | Thread Switcher | Search/Command | Open | Terminal  |
+-------------------+-------------------------+------------------------------------+
| Projects          | Threads                 | Context Header                     |
|                   |                         | Thread Title        Running / Idle  |
| Project A   3     | New Thread              | Project / Branch / Model / Access  |
| Project B   1     | Filters: Active Unread  +------------------------------------+
| Project C         |-------------------------| View Tabs                           |
|                   | Pinned                  | Transcript | Terminal | Changes     |
|                   | Fix unread dot bug      |------------------------------------|
|                   | Release prep            |                                    |
|                   |                         | Main Output Surface                 |
|                   | Recent                  |                                    |
|                   | Draft follow-up         |                                    |
|                   | Refactor eval           |                                    |
|                   |                         |                                    |
+-------------------+-------------------------+------------------------------------+
| Composer: [Attach] [Prompt input.........................................] [Send]|
| Secondary row: permissions | context left | skills/agent | interrupt | clear     |
+----------------------------------------------------------------------------------+
```

Key layout decisions:

- Projects become a stable first-level navigation rail.
- Threads get their own pane with filters and quick-create.
- The header becomes a context strip, not a utility shelf.
- The main surface supports more than one reading mode.
- The composer becomes the center of action, with runtime controls attached to it.

## Closing Assessment

Claudex already has a credible product core because it solves a real pain: persistent, multi-project AI coding work on top of local Claude CLI. The launch risk is not the idea. The launch risk is that the UI still makes users think too hard about structure and state.

If the product wants to feel competitive with Raycast, Cursor, or Linear-grade tools, the next design pass should focus less on incremental polish and more on hierarchy surgery:

- separate navigation layers
- clarify context ownership
- make the app keyboard-first
- add a review layer above raw terminal output
- stop letting utility controls compete with primary workflow
