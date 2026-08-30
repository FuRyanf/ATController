import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync('src/styles.css', 'utf8');

function declarationBlock(selector: string) {
  const start = styles.indexOf(`${selector} {`);
  expect(start, `missing ${selector} rule`).toBeGreaterThanOrEqual(0);
  const end = styles.indexOf('}', start);
  expect(end, `unterminated ${selector} rule`).toBeGreaterThan(start);
  return styles.slice(start, end + 1);
}

describe('persistent rendering indicators', () => {
  it('keeps long-lived turn and submission indicators static', () => {
    expect(declarationBlock('.pending-submission-status > span')).not.toMatch(/\banimation\s*:/);
    expect(declarationBlock('.timeline-agent-message.streaming::after')).not.toMatch(
      /\banimation\s*:/
    );
    expect(declarationBlock('.activity-indicator.live')).not.toMatch(/\banimation\s*:/);
    expect(styles).not.toMatch(/@keyframes\s+(?:activity-pulse|cursor-pulse)\b/);
  });
});
