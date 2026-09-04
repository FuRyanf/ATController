import { describe, expect, it } from 'vitest';

import {
  gitBranchesEqual,
  gitInfoEqual,
  gitStatusEqual
} from '../../src/lib/gitState';

describe('Git state equality', () => {
  it('keeps equivalent Git summaries referentially eligible for reuse', () => {
    const info = {
      branch: 'main',
      shortHash: 'abc1234',
      isDirty: true,
      ahead: 1,
      behind: 0,
      isMainWorktree: true
    };
    expect(gitInfoEqual(info, { ...info })).toBe(true);
    expect(gitInfoEqual(info, { ...info, ahead: 2 })).toBe(false);
  });

  it('detects actual status and branch changes', () => {
    const status = {
      isDirty: true,
      uncommittedFiles: 1,
      insertions: 4,
      deletions: 1,
      files: [
        {
          path: 'src/App.tsx',
          status: 'modified',
          staged: false,
          insertions: 4,
          deletions: 1,
          binary: false
        }
      ]
    };
    expect(gitStatusEqual(status, { ...status, files: [...status.files] })).toBe(
      true
    );
    expect(
      gitStatusEqual(status, {
        ...status,
        files: [{ ...status.files[0], staged: true }]
      })
    ).toBe(false);

    const branches = [{ name: 'main', isCurrent: true, lastCommitUnix: 1 }];
    expect(gitBranchesEqual(branches, [...branches])).toBe(true);
    expect(
      gitBranchesEqual(branches, [
        { ...branches[0], lastCommitUnix: 2 }
      ])
    ).toBe(false);
  });
});
