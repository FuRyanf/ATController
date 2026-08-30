import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  threadDraftStore,
  useThreadDraft
} from '../../src/stores/threadDraftStore';

function DraftValue({
  threadId,
  persistedDraft,
  onRender
}: {
  threadId: string;
  persistedDraft: string;
  onRender: () => void;
}) {
  onRender();
  const value = useThreadDraft(threadId, persistedDraft);
  return <output aria-label={threadId}>{value}</output>;
}

afterEach(() => threadDraftStore.clear());

describe('thread draft store', () => {
  it('updates only subscribers for the changed thread', () => {
    let firstRenders = 0;
    let secondRenders = 0;
    render(
      <>
        <DraftValue
          threadId="thread-1"
          persistedDraft="First persisted draft"
          onRender={() => {
            firstRenders += 1;
          }}
        />
        <DraftValue
          threadId="thread-2"
          persistedDraft="Second persisted draft"
          onRender={() => {
            secondRenders += 1;
          }}
        />
      </>
    );
    const secondRendersBeforeUpdate = secondRenders;

    act(() => threadDraftStore.set('thread-1', 'Typing stays local'));

    expect(screen.getByLabelText('thread-1')).toHaveTextContent(
      'Typing stays local'
    );
    expect(screen.getByLabelText('thread-2')).toHaveTextContent(
      'Second persisted draft'
    );
    expect(firstRenders).toBeGreaterThan(1);
    expect(secondRenders).toBe(secondRendersBeforeUpdate);
  });

  it('falls back to persisted text and restores it when a local draft is deleted', () => {
    render(
      <DraftValue
        threadId="thread-1"
        persistedDraft="Persisted"
        onRender={() => undefined}
      />
    );
    expect(screen.getByLabelText('thread-1')).toHaveTextContent('Persisted');

    act(() => threadDraftStore.set('thread-1', 'Local'));
    expect(screen.getByLabelText('thread-1')).toHaveTextContent('Local');

    act(() => threadDraftStore.delete('thread-1'));
    expect(screen.getByLabelText('thread-1')).toHaveTextContent('Persisted');
  });
});
