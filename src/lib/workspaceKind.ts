import type { Workspace } from '../types';

export function isRemoteWorkspaceKind(kind: Workspace['kind']): boolean {
  return kind === 'rdev' || kind === 'ssh';
}
