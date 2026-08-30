import type {
  GitBranchEntry,
  GitChangedFile,
  GitInfo,
  GitWorkspaceStatus
} from '../types';

export function gitInfoEqual(
  left: GitInfo | null | undefined,
  right: GitInfo | null | undefined
): boolean {
  return (
    left === right ||
    (left != null &&
      right != null &&
      left.branch === right.branch &&
      left.shortHash === right.shortHash &&
      left.isDirty === right.isDirty &&
      left.ahead === right.ahead &&
      left.behind === right.behind &&
      left.isMainWorktree === right.isMainWorktree &&
      left.worktreeLabel === right.worktreeLabel &&
      left.worktreePath === right.worktreePath)
  );
}

function changedFileEqual(left: GitChangedFile, right: GitChangedFile): boolean {
  return (
    left.path === right.path &&
    left.status === right.status &&
    left.staged === right.staged &&
    left.insertions === right.insertions &&
    left.deletions === right.deletions &&
    left.binary === right.binary
  );
}

export function gitStatusEqual(
  left: GitWorkspaceStatus | null | undefined,
  right: GitWorkspaceStatus | null | undefined
): boolean {
  return (
    left === right ||
    (left != null &&
      right != null &&
      left.isDirty === right.isDirty &&
      left.uncommittedFiles === right.uncommittedFiles &&
      left.insertions === right.insertions &&
      left.deletions === right.deletions &&
      left.files.length === right.files.length &&
      left.files.every((file, index) =>
        changedFileEqual(file, right.files[index])
      ))
  );
}

export function gitBranchesEqual(
  left: GitBranchEntry[],
  right: GitBranchEntry[]
): boolean {
  return (
    left === right ||
    (left.length === right.length &&
      left.every(
        (branch, index) =>
          branch.name === right[index].name &&
          branch.isCurrent === right[index].isCurrent &&
          branch.lastCommitUnix === right[index].lastCommitUnix
      ))
  );
}
