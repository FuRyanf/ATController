import { describe, expect, it } from 'vitest';

import {
  createRunLifecycleState,
  isStreamingStuck,
  markRunExited,
  markRunReady,
  markRunStreaming,
  noteRunOutput
} from '../../src/lib/terminalRunLifecycle';

describe('terminal run lifecycle', () => {
  it('tracks starting -> streaming -> exited transitions', () => {
    let state = createRunLifecycleState(1_000);
    expect(state.phase).toBe('starting');

    state = markRunReady(state, 1_100);
    expect(state.phase).toBe('ready');

    state = markRunStreaming(state, 1_200);
    expect(state.phase).toBe('streaming');

    state = markRunExited(2_000);
    expect(state.phase).toBe('exited');
  });

  it('marks streaming as stuck when only control/noise output keeps arriving', () => {
    let now = 10_000;
    let state = markRunStreaming(createRunLifecycleState(now), now);

    for (let index = 0; index < 40; index += 1) {
      now += 500;
      state = noteRunOutput(state, false, now);
    }

    expect(isStreamingStuck(state, now, 15_000)).toBe(true);
  });

  it('resets stuck timer when meaningful output arrives', () => {
    let now = 20_000;
    let state = markRunStreaming(createRunLifecycleState(now), now);

    now += 14_000;
    state = noteRunOutput(state, false, now);
    expect(isStreamingStuck(state, now, 15_000)).toBe(false);

    now += 500;
    state = noteRunOutput(state, true, now);
    expect(isStreamingStuck(state, now, 15_000)).toBe(false);

    now += 14_900;
    state = noteRunOutput(state, false, now);
    expect(isStreamingStuck(state, now, 15_000)).toBe(false);
  });
});
